// Ledger — a paper bot for the pump.fun replay sprint.
//
// The idea: a fresh bonding curve can only fall back to about its creation
// price, while a runner can pay several times it. The expensive seat is
// buying after the run-up; the cheap seat is buying while the curve is
// still near its base and leaving on a clock, before the retrace eats the
// gain. So this bot only ever buys a coin while its price is still close
// to its creation price, adds a little more only while the price is
// stepping up, and sells every position whole a fixed number of slots
// after it opened. A high take-profit and a tight stop sit above and
// below as backstops; the clock does the real work.
//
// Everything here is a pure function of the batches: no clock, no
// randomness, no I/O, so the two graded executions decide the same orders.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

/** All tunables in one place. Multiples are basis points over the creation price (10000 = 1.00x). */
export interface LedgerParams {
  /** SOL spent on the first buy of a coin. */
  firstBuyLamports: bigint;
  /** SOL spent on each add to a coin already held. */
  addBuyLamports: bigint;
  /** Adds allowed after the first buy. */
  maxAdds: number;
  /** Highest creation-price multiple a first buy is allowed at. */
  enterMultBps: number;
  /** Highest creation-price multiple an add is allowed at. */
  addMultBps: number;
  /** The price must have risen at least this much (bps) since the last buy before an add. */
  addStepBps: number;
  /** Slots after the first buy when the whole position is sold. */
  holdSlots: number;
  /** Multiple over the entry multiple that takes profit early (0 = off). */
  takeProfitBps: number;
  /** Multiple under the entry multiple that stops out early (0 = off). */
  stopBps: number;
  /** A buy smaller than this is not worth its transaction fees. */
  minBuyLamports: bigint;
  /** Slots after creation inside which a first buy may still happen (0 = no limit). */
  enterWindowSlots: number;
  /** Arm the trailing exit once the multiple reaches this much over the entry multiple (0 = off). */
  armMultBps: number;
  /** Once armed, sell when the multiple falls to this share of its peak (bps, 0 = off). */
  trailBps: number;
  /** Sell early when the coin is still under this multiple over entry after this many slots (0 = off). */
  earlyExitSlots: number;
  earlyExitMultBps: number;
  /** At the hold deadline, extend the hold by holdSlots when the multiple is at least this much over entry (0 = off). */
  extendMultBps: number;
  /** How many times the hold may be extended. */
  maxExtensions: number;
  /** Only buy when the multiple rose at least this much (bps) over the last this many slots (0 = off). */
  momentumSlots: number;
  momentumBps: number;
  /** After a sale, let the coin be bought again while it still qualifies (completes never re-enter). */
  allowReentry: boolean;
  /** Slippage allowance on every order. */
  slippageBps: number;
}

export const DEFAULT_PARAMS: LedgerParams = {
  firstBuyLamports: (LAMPORTS_PER_SOL * 8n) / 100n,
  addBuyLamports: (LAMPORTS_PER_SOL * 5n) / 100n,
  maxAdds: 2,
  enterMultBps: 11000,
  addMultBps: 13000,
  addStepBps: 500,
  holdSlots: 100,
  takeProfitBps: 0,
  stopBps: 0,
  minBuyLamports: LAMPORTS_PER_SOL / 100n,
  enterWindowSlots: 0,
  armMultBps: 0,
  trailBps: 0,
  earlyExitSlots: 0,
  earlyExitMultBps: 10500,
  extendMultBps: 0,
  maxExtensions: 3,
  momentumSlots: 60,
  momentumBps: 400,
  allowReentry: false,
  slippageBps: 10000,
};

type CoinStatus = 'watch' | 'opening' | 'open' | 'done';

interface CoinNote {
  baseVq: bigint;
  baseVt: bigint;
  bornSlot: number;
  status: CoinStatus;
  attempts: number;
  buys: number;
  entryMultBps: number;
  lastBuyMultBps: number;
  firstBuySlot: number;
  peakMultBps: number;
  trailArmed: boolean;
  exitSlot: number;
  extended: number;
  reenter: boolean;
  hist: Array<{ slot: number; mult: number }>;
}

/** Creation-price multiple of a curve, in basis points, computed in exact bigint arithmetic. */
function multipleBps(
  vq: bigint,
  vt: bigint,
  baseVq: bigint,
  baseVt: bigint,
): number {
  if (vt === 0n || baseVq === 0n || baseVt === 0n) return 10000;
  const m = (vq * baseVt * 10000n) / (vt * baseVq);
  if (m > 9007199254740991n) return 9007199254740991;
  if (m < 0n) return 0;
  return Number(m);
}

export function createStrategy(p: LedgerParams): {
  onBatch(state: BotState, batch: Batch): OrderInput[];
} {
  const coins = new Map<string, CoinNote>();

  function noteFor(mint: string, slot: number, vq: bigint, vt: bigint): CoinNote {
    let note = coins.get(mint);
    if (note === undefined) {
      note = {
        baseVq: vq,
        baseVt: vt,
        bornSlot: slot,
        status: 'watch',
        attempts: 0,
        buys: 0,
        entryMultBps: 0,
        lastBuyMultBps: 0,
        firstBuySlot: 0,
        peakMultBps: 0,
        trailArmed: false,
        exitSlot: 0,
        extended: 0,
        reenter: false,
        hist: [],
      };
      coins.set(mint, note);
    }
    return note;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const maxOrders = state.hello.caps.max_orders_per_batch;

      // Register every coin this batch mentions, with its creation reserves
      // as the base its multiple is measured against. A coin first seen
      // through a trade (created before the window) takes that trade's
      // reserves as its base.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          noteFor(e.mint, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        } else if (e.event === 'TradeEvent') {
          noteFor(e.mint, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        } else if (e.event === 'CompleteEvent') {
          const note = coins.get(e.mint);
          if (note !== undefined) note.status = 'done';
        }
      }

      // Track each coin's multiple history for the momentum filter: one
      // sample per batch the coin appears in, capped at the last 16.
      for (const e of batch.events) {
        if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
        const note = coins.get(e.mint);
        const curve = state.curves.get(e.mint);
        if (note === undefined || curve === undefined || curve.complete) continue;
        const mult = multipleBps(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          note.baseVq,
          note.baseVt,
        );
        note.hist.push({ slot: batch.slot, mult });
        if (note.hist.length > 16) note.hist.shift();
      }

      // Reconcile what we think a coin is with what the account says: a
      // position means open, a buy still in flight means opening, a coin
      // that was open or opening with neither means its position closed
      // (sold, completed, flattened) or its buy never filled. A sell in
      // flight keeps the coin open, and a sell that was refused leaves
      // the position held, so the exit is retried next batch instead of
      // stranding the position.
      const pendingBuys = new Set<string>();
      const pendingSells = new Set<string>();
      for (const pending of state.pending.values()) {
        if (pending.order.side === 'buy') pendingBuys.add(pending.order.mint);
        else pendingSells.add(pending.order.mint);
      }
      for (const [mint, note] of coins) {
        if (state.positions.has(mint)) {
          note.status = 'open';
          if (note.firstBuySlot === 0) note.firstBuySlot = batch.slot;
        } else if (pendingBuys.has(mint)) {
          note.status = 'opening';
        } else if (note.status === 'open') {
          // The position closed. A sale leaves the coin watchable again
          // when re-entry is on; a harness close does not.
          if (note.reenter) {
            note.status = 'watch';
            note.buys = 0;
            note.attempts = 0;
            note.entryMultBps = 0;
            note.lastBuyMultBps = 0;
            note.firstBuySlot = 0;
            note.peakMultBps = 0;
            note.exitSlot = 0;
            note.extended = 0;
          } else {
            note.status = 'done';
          }
          note.reenter = false;
        } else if (note.status === 'opening') {
          note.status = 'watch';
        }
      }

      // Exits first: the clock, the take-profit and the stop, each selling
      // the whole position. Completed curves are left to the harness. A
      // coin with a sell already in flight is not sold twice; the sale
      // itself is only marked done once the position is actually gone.
      for (const [mint, note] of coins) {
        if (orders.length >= maxOrders) break;
        if (note.status !== 'open') continue;
        if (pendingSells.has(mint)) continue;
        const held = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (held === undefined || curve === undefined || curve.complete) continue;
        const mult = multipleBps(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          note.baseVq,
          note.baseVt,
        );
        if (mult > note.peakMultBps) note.peakMultBps = mult;
        if (p.armMultBps > 0 && !note.trailArmed) {
          note.trailArmed = mult * 10000 >= note.entryMultBps * p.armMultBps;
        }
        const age = batch.slot - note.firstBuySlot;
        let exit = batch.slot >= note.exitSlot;
        if (exit && p.extendMultBps > 0 && note.extended < p.maxExtensions) {
          // A coin still running at its deadline gets more time instead
          // of being sold into its own run.
          if (mult * 10000 >= note.entryMultBps * p.extendMultBps) {
            note.exitSlot += p.holdSlots;
            note.extended += 1;
            exit = false;
          }
        }
        if (!exit && p.takeProfitBps > 0) {
          exit = mult * 10000 >= note.entryMultBps * p.takeProfitBps;
        }
        if (!exit && p.stopBps > 0) {
          exit = mult * 10000 <= note.entryMultBps * p.stopBps;
        }
        if (!exit && p.earlyExitSlots > 0 && age >= p.earlyExitSlots) {
          // A coin that never got going is cut early: its fees are the
          // same whether it is sold now or at the deadline.
          exit = mult * 10000 < note.entryMultBps * p.earlyExitMultBps;
        }
        if (note.trailArmed && p.trailBps > 0) {
          // A runner that has armed the trail stays open past the clock
          // and past the take-profit until it gives back the trailing
          // share of its peak.
          exit = mult * 10000 <= note.peakMultBps * p.trailBps;
        }
        if (!exit) continue;
        const sell: SellInput = {
          side: 'sell',
          mint,
          token_amount: held.token_amount,
          max_slippage_bps: p.slippageBps,
        };
        orders.push(sell);
        note.reenter = p.allowReentry;
      }

      // Entries and adds, in the order the batch's events arrived.
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const e of batch.events) {
        if (orders.length >= maxOrders) break;
        if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
        const mint = e.mint;
        const note = coins.get(mint);
        if (note === undefined) continue;
        if (note.status === 'done' || note.status === 'opening') continue;
        if (pendingSells.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) {
          note.status = 'done';
          continue;
        }
        const mult = multipleBps(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          note.baseVq,
          note.baseVt,
        );
        if (note.status === 'watch') {
          if (note.attempts >= 2) {
            note.status = 'done';
            continue;
          }
          if (p.enterWindowSlots > 0 && batch.slot - note.bornSlot > p.enterWindowSlots) {
            note.status = 'done';
            continue;
          }
          if (mult > p.enterMultBps) continue;
          if (p.momentumSlots > 0) {
            // The multiple must have risen at least momentumBps over the
            // last momentumSlots: a coin grinding up slowly is skipped.
            let ref: { slot: number; mult: number } | undefined;
            for (let i = note.hist.length - 1; i >= 0; i--) {
              if (note.hist[i].slot <= batch.slot - p.momentumSlots) {
                ref = note.hist[i];
                break;
              }
            }
            if (ref === undefined) continue;
            if ((mult - ref.mult) * 10000 < ref.mult * p.momentumBps) continue;
          }
          const cap = state.maxBuyLamports(mint);
          if (cap < p.minBuyLamports) continue;
          if (slotsLeft <= 0) continue;
          const amount = cap < p.firstBuyLamports ? cap : p.firstBuyLamports;
          if (free < amount + tx) continue;
          const buy: BuyInput = {
            side: 'buy',
            mint,
            quote_lamports: amount,
            max_slippage_bps: p.slippageBps,
          };
          orders.push(buy);
          free -= amount + tx;
          slotsLeft -= 1;
          note.status = 'opening';
          note.attempts += 1;
          note.buys = 1;
          note.entryMultBps = mult;
          note.lastBuyMultBps = mult;
          note.peakMultBps = mult;
          note.trailArmed = false;
          note.firstBuySlot = batch.slot;
          note.exitSlot = batch.slot + p.holdSlots;
          note.extended = 0;
        } else {
          if (note.buys >= 1 + p.maxAdds) continue;
          if (mult > p.addMultBps) continue;
          if (mult * 10000 < note.lastBuyMultBps * (10000 + p.addStepBps)) continue;
          const cap = state.maxBuyLamports(mint);
          if (cap < p.minBuyLamports) continue;
          const amount = cap < p.addBuyLamports ? cap : p.addBuyLamports;
          if (free < amount + tx) continue;
          const buy: BuyInput = {
            side: 'buy',
            mint,
            quote_lamports: amount,
            max_slippage_bps: p.slippageBps,
          };
          orders.push(buy);
          free -= amount + tx;
          note.buys += 1;
          note.lastBuyMultBps = mult;
        }
      }

      return orders;
    },
  };
}

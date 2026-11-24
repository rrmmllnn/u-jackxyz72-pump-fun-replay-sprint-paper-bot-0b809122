[![Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rrmmllnn/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rrmmllnn/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Ledger — Pump.fun Replay Sprint: Paper Bot, Real Ranking

A Solana paper-trading bot for the house `pumpfun-replay` template. It trades
10 SOL of paper money on a replay of pump.fun bonding-curve data.

## Idea

A fresh bonding curve can only fall back to about its creation price, while a
runner can pay several times it — but most coins never run at all, and every
round trip pays about 2.5% in curve fees plus two transaction fees. Buying
every coin that reaches the size cap loses money on the fees alone: on the
dev window that shape scored about −0.18 SOL over 358 coins.

So this bot is picky. It only buys a coin while its price is still within
1.10x of its creation price **and** the price rose at least 4% over the last
60 slots — a coin grinding sideways never qualifies, and a coin that already
ran away is never chased. It adds a little more only while the price keeps
stepping up, and it sells every position whole 100 slots after it opened:
most of a runner's gain shows up in the first minute or two, and holding
longer mostly pays the retrace back. A trailing exit, a take-profit, a stop
and a hold extension are all in the code as backstops, switched off in the
shipped settings because each one measured worse than the plain clock on
the dev window.

Dev-window result (kit's frozen data, `grade-local --driver process`):
net **−0.0033 SOL**, 30 coins, 69 fills, 31 round trips, win rate 16.1%,
max drawdown 0.13%, 0 rejected, 0 failed; guardrails met. The local
replay agreed (−0.0028 SOL, 69 fills). That is effectively break-even:
the bot is a coin flip away from a small profit on this window, and its
score on the final window will be decided by whether it catches one or two
of that window's runners. Reported honestly: this is not a bot with a
proven edge, it is a disciplined filter that stops paying fees to coins
that never run.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`
- `strategy.ts` — the whole strategy (pure function of the batches: no clock,
  no randomness, no I/O, so the two graded executions decide the same orders)
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied unchanged

## Grade locally

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

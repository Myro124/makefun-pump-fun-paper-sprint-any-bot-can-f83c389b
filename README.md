# makefun-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Myro124/makefun-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Myro124/makefun-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

TigaDetik — an early-tape launch sniper for the pump.fun paper replay. It watches every new bonding curve from its CreateEvent and buys only launches that already hold at least 2 SOL, have at least 3 trades from at most 3 distinct non-creator wallets, and whose creator has not sold. It probes with 0.05 SOL, pyramids up to twice more (0.1 SOL each) when the price rises at least 5% above the last buy, trims a quarter of the position at +10%, sells the rest at +30% or -20%, and never holds past 10 slots. Pure function of the replay batches: no clock, no randomness, no network.

Dev window (kit grade-local, full 24h sample): net PnL -0.056 SOL, 117 coins, 288 fills, 22% win rate, 2.2% max drawdown, guardrails met.

## Run it

The grader runs `node /bot/main.ts` with this directory mounted at `/bot`. The SDK shim is vendored at `vendor/makefun-bot.ts`.

---

Entered on [make.fun](https://make.fun/?ref=gyq1s73s&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards

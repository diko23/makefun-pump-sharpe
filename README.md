# makefun-pump-sharpe

[![Pump.fun Sharpe Sprint](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/diko23/makefun-pump-sharpe/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/diko23/makefun-pump-sharpe/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) competition (`agent-fun/replay/v2`).

## Strategy

Designed for smooth, consistent hourly returns and low drawdown rather than concentrated moonshots:

- **Late-Curve Organic Momentum Filter**: Tracks per-mint trade history from `CreateEvent` onward and enters only established, non-bundled curves between `48.5 SOL` and `78.5 SOL` real quote reserve (`age >= 15` slots, `>= 22` distinct buyers, `< 30%` single-buyer share, within `12%` of peak reserve, `>= 15 SOL` net inflow), requiring genuine two-sided profit-taking (`>= 16` sells and sell volume `>= 25%` of buy volume) to avoid sybil hold-and-rug traps.
- **Even Sizing & Slot Rotation**: Deploys a uniform `0.180 SOL` stake per coin (within an `85%` buffer of `maxBuyLamports` to prevent `s -> s+2` reserve-cap rejections), trading each mint at most once and rotating up to 5 open slots.
- **Fee-Aware Exits**: Marks positions to market net of curve (`125 bps`) and tx (`105,000` lamports) fees. Cuts losers at `-18%` net, takes `50%` partial profit at `+16%` net, caps remaining upside at `+28%` net (with a `10%` trailing stop activated after TP1 above `+22%` net), and exits stagnant positions after `700` slots below `+5%` net.
- **Deterministic**: Zero external state, clock, env, or `Math.random` usage.

## Run it

Runs directly on Node 22+ (`node /bot/main.ts` in the competition sandbox) with zero dependencies:

```bash
node main.ts
```

Communicates over `stdin`/`stdout` using `agent-fun/replay/v2` via `./vendor/makefun-bot.ts`.

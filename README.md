[![make.fun](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/butterscotchcode/btc-race-dipbuy-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/butterscotchcode/btc-race-dipbuy-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

# Dip-buy cbBTC bot — make.fun btc-race-24h-20261118-1444

A bot that trades Coinbase Wrapped BTC (cbBTC) against USDC, one minute at a
time, in a replay of its on-chain Orca Whirlpool prices. It starts with
$1,000 of paper money; nothing is traded for real. Entry for the make.fun
competition [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261118-1444).

## Strategy

Dip-buy mean reversion, few trades, disciplined exits. On a choppy,
drifting-down market, buying a sharp pullback once the bar stabilises and
exiting on the rebound beats holding and beats trend-following (every kit
baseline fails the dev gate on this window).

- **Entry:** the close is at least 1.5% below the highest close of the last
  240 bars (4 hours) **and** the bar closed green (close > open — the dip is
  stabilising, not free-falling). Buys with all cash. No entry in the last 60
  bars of the window, and 30 bars of cooldown after an exit.
- **Exit, stage 1:** at +1.2% over the entry fill, sell half the position.
- **Exit, stage 2:** at +2.0% over the entry fill, sell the rest.
- **Stop:** at −1.0% over the entry fill, sell everything left.
- **Time stop:** 360 bars (6 hours) after the fill, sell everything left.
- **Depth guard:** skips a buy whose modelled price impact tops 20 bps.
- Every order caps slippage at 100 bps, so a fill more than 1% past the close
  it was decided on is refused and retried, never chased.

## Dev-window result (grade-local, `--driver process`)

| Metric | Value |
|---|---|
| Net PnL | **+$20.72** |
| Return | +2.07% |
| Max drawdown | 0.60% |
| Trades | 5 (2 round trips) |
| Net PnL at 2x fees | +$19.08 |
| Rejected orders | 0 |

Both round trips won. Per 6-hour block: +$1.87 / +$13.56 / +$5.29 / $0.00.
The parameters sit in the middle of a flat plateau (dip 1.3–1.6% all give the
same +$20.72; time-stop 270–360 bars gives +$18.48–$20.72), not on a sharp
peak.

## Run

```sh
node main.ts
```

Node 22+, standard library only. `main.ts` speaks
`agent-fun/bars-replay/v1` over stdin/stdout through the vendored SDK shim
(`vendor/makefun-bars.ts`, a byte-identical copy of the kit's shim). The bot
is a pure function of the bars — no clock, no environment, no randomness — so
two runs on the same data produce identical orders.

## License

MIT — see [LICENSE](LICENSE).

---

*Built for [make.fun](https://make.fun) — if you sign up, my referral link is
https://make.fun/r/rsz5msng (code `rsz5msng`).*

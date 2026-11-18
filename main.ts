// Dip-buy mean-reversion bot for cbBTC/USDC, 1-minute bars, long only.
//
// Idea: on a choppy, drifting-down market the winning shape is to buy a sharp
// pullback from the recent high once the bar stabilises, then exit on the
// rebound in two stages (bank half early, let half run), with a tight stop and
// a time stop so no position is left hanging through a slow grind. A full-size
// round trip pays ~26 bps in fee + slippage + impact, so every trade must
// catch a move well above that; that is why entries are rare (a 1.5% dip from
// the 4-hour high) and exits are patient (up to 6 hours).
//
// Rules, per bar close (fills land at the next bar's open):
//   - Entry: close >= 1.5% below the highest close of the last 240 bars
//     (4 hours) AND the bar closed green (close > open: the dip is
//     stabilising, not free-falling). Buy with all cash. No entry in the last
//     60 bars of the window (a position opened there cannot exit cleanly and
//     would be flattened at the close), and 30 bars of cooldown after an exit.
//   - Exit stage 1: at +1.2% over the entry fill, sell half the position.
//   - Exit stage 2: at +2.0% over the entry fill, sell the rest.
//   - Stop: at -1.0% over the entry fill, sell the whole remaining position.
//   - Time stop: 360 bars (6 hours) after the fill, sell the rest.
//   - Depth guard: skip a buy when its modelled price impact tops 20 bps.
//   - max_slippage_bps 100 on every order, so a fill more than 1% past the
//     close it was decided on is refused and retried, never chased.
//
// Everything is a pure function of the bars: no clock, no environment, no
// randomness, so two runs on the same data give the same orders.

import { runBars, type BarsState, type Bar, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Rolling-high lookback, in bars (240 bars = 4 hours). */
const LOOKBACK_BARS = 240;
/** Entry: pullback from the rolling high, in basis points. */
const DIP_BPS = 150;
/** Stage-1 exit: gain over the entry fill, in basis points; sells half. */
const TP1_BPS = 120;
/** Stage-2 exit: gain over the entry fill, in basis points; sells the rest. */
const TP2_BPS = 200;
/** Stop loss: loss over the entry fill, in basis points. */
const STOP_BPS = 100;
/** Time stop: bars after the entry fill, then sell the rest. */
const TIME_STOP_BARS = 360;
/** Bars of cooldown after a position is fully closed. */
const COOLDOWN_BARS = 30;
/** No new entry once this bar index of the 1,440-bar window is passed. */
const NO_ENTRY_AFTER_BAR = 1380;
/** Per-order slippage cap, in basis points. */
const MAX_SLIPPAGE_BPS = 100;
/** Skip a buy whose modelled price impact tops this, in basis points. */
const MAX_IMPACT_BPS = 20;

const BPS = 10_000;

/** Closes of the bars seen so far, oldest first, raw price units. */
const closes: number[] = [];
/** Fill price of the open position (raw price units), 0 while flat. */
let entryPrice = 0;
/** Bar index of the entry fill (0-based count of bars seen), -1 while flat. */
let entryBar = -1;
/** Whether the stage-1 (half) exit already fired for this position. */
let stage1Done = false;
/** No new entry before this bar index (cooldown after an exit). */
let coolUntilBar = -1;

/** Highest close of the last LOOKBACK_BARS bars, or null before enough bars. */
function rollingHigh(): number | null {
  if (closes.length < LOOKBACK_BARS) return null;
  let high = -Infinity;
  for (let i = closes.length - LOOKBACK_BARS; i < closes.length; i++) {
    if (closes[i]! > high) high = closes[i]!;
  }
  return high;
}

await runBars({
  onBatch(state: BarsState, batch) {
    // Fold this batch's bars in first, so the bar count is the bar index.
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(Number(bar.c));
    }
    // Then fold in this batch's fills: they set the entry fill (price, bar
    // index) and mark a full exit (cooldown starts at the fill bar). Note
    // fill.fill_bar is the bar's TIME in ms, not its index: the bar index is
    // closes.length - 1, the bar this batch just closed at.
    const fillBar = closes.length - 1;
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = Number(fill.price);
        entryBar = fillBar;
        stage1Done = false;
      } else if (state.positions.get(SYMBOL) === undefined) {
        coolUntilBar = fillBar + COOLDOWN_BARS;
      }
    }
    if (state.warmingUp) return [];
    const bar: Bar | undefined = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    const held = state.positions.get(SYMBOL);
    const orders: (BuyInput | SellInput)[] = [];
    // Index of the bar being answered (0-based).
    const barIdx = closes.length - 1;

    if (held !== undefined && entryPrice > 0) {
      // --- managing an open position -------------------------------------
      const gainBps = ((close - entryPrice) / entryPrice) * BPS;
      const heldBars = barIdx - entryBar;
      if (!stage1Done && gainBps >= TP1_BPS) {
        // Bank half at +1.2%.
        const half = held.qty / 2n;
        if (half > 0n) {
          orders.push({ side: 'sell', symbol: SYMBOL, qty: half, max_slippage_bps: MAX_SLIPPAGE_BPS });
          stage1Done = true;
        }
      } else if (gainBps >= TP2_BPS || gainBps <= -STOP_BPS || heldBars >= TIME_STOP_BARS) {
        // Let the rest run to +2.0%, or cut at -1.0%, or time out after 6h.
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      return orders;
    }

    // --- looking for an entry --------------------------------------------
    if (barIdx < LOOKBACK_BARS || barIdx > NO_ENTRY_AFTER_BAR || barIdx < coolUntilBar) return [];
    const high = rollingHigh();
    if (high === null) return [];
    const dipBps = ((high - close) / close) * BPS;
    // Green bar: the dip is stabilising, not still falling.
    const green = close > Number(bar.o);
    if (dipBps < DIP_BPS || !green) return [];
    // Depth guard: never pay more than 20 bps of impact on the entry.
    const impact = state.impactBps(SYMBOL, state.cash);
    if (impact === null || impact > BigInt(MAX_IMPACT_BPS)) return [];
    let notional = state.cash;
    const room = state.weightRoom(SYMBOL);
    if (notional > room) notional = room;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
    return orders;
  },
});

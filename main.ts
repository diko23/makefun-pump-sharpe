import {
  BPS,
  runBot,
  type Batch,
  type BotState,
  type Curve,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// Strategy parameters (v10: uniform 0.18 SOL stake @ 48.5 SOL, anti-bundle filter, capped TP2=12800 for <30% concentration & >=20 coins)
const TARGET_BUY_LAMPORTS = 180_000_000n; // 0.180 SOL uniform stake per position (1.8% of 10 SOL capital)
const MIN_BUY_LAMPORTS = 40_000_000n; // 0.040 SOL floor (well above 0.01 SOL guardrail)
const MIN_REAL_RESERVE = 48_500_000_000n; // 48.5 SOL (gives >=23 coins margin over 20-coin guardrail)
const MAX_REAL_RESERVE = 78_500_000_000n; // 78.5 SOL (avoid chasing right at completion boundary)
const CAP_BUFFER_BPS = 8500n; // Stay under 85% of maxBuyLamports to absorb s -> s+2 reserve dips

const MIN_AGE_SLOTS = 15; // Skip slot-0/1 atomic bundles
const MAX_AGE_SLOTS = 5000;
const RECENT_WINDOW_SLOTS = 25;

const MIN_DISTINCT_BUYERS = 22;
const MIN_SELL_COUNT = 16; // Require active two-sided distribution, filtering sybil hold-and-rug bundles
const MIN_SELL_BUY_RATIO_BPS = 2500n; // totalSellSol >= 25% of totalBuySol
const MIN_NET_SOL_FLOW = 15_000_000_000n; // 15.0 SOL net inflow
const MAX_SINGLE_BUYER_BPS = 3000n; // < 30% single-wallet concentration
const NEAR_PEAK_BPS = 8800n; // Within 12% of coin's peak real SOL reserve
const MIN_RECENT_BUYS = 1;

const STOP_LOSS_BPS = 8200n; // Exit 100% if net liquidation <= 82% of cost (-18% net)
const TP1_BPS = 11600n; // Sell 50% at >= +16% net
const TP2_BPS = 12800n; // Sell remaining at >= +28% net (caps tail concentration & smooths hourly returns)
const TRAIL_START_BPS = 12200n; // Activate trailing stop only after TP1 and >= +22% net
const TRAIL_KEEP_BPS = 9000n; // Exit on 10% pullback from peak per-token value
const TIME_STOP_SLOTS = 700;
const TIME_STOP_MAX_BPS = 10500n; // Time-exit stagnant trades below +5% net

const BUY_SLIPPAGE_BPS = 1500;
const NORMAL_SLIPPAGE_BPS = 1500;
const URGENT_SLIPPAGE_BPS = 3000;
const PRICE_SCALE = 1_000_000_000_000n;

interface RecentTrade {
  slot: number;
  isBuy: boolean;
  sol: bigint;
}

interface MintStats {
  buyers: Map<Pubkey, bigint>;
  totalBuySol: bigint;
  totalSellSol: bigint;
  buyCount: number;
  sellCount: number;
  maxBuyerSol: bigint;
  peakRealReserve: bigint;
  recent: RecentTrade[];
}

interface PosTracker {
  entrySlot: number;
  tp1Sent: boolean;
  tp1Filled: boolean;
  peakValuePerToken: bigint;
}

const mintStats = new Map<Pubkey, MintStats>();
const trackers = new Map<Pubkey, PosTracker>();
const enteredMints = new Set<Pubkey>();

function getOrCreateStats(mint: Pubkey): MintStats {
  let s = mintStats.get(mint);
  if (s === undefined) {
    s = {
      buyers: new Map<Pubkey, bigint>(),
      totalBuySol: 0n,
      totalSellSol: 0n,
      buyCount: 0,
      sellCount: 0,
      maxBuyerSol: 0n,
      peakRealReserve: 0n,
      recent: [],
    };
    mintStats.set(mint, s);
  }
  return s;
}

function pruneRecent(stats: MintStats, currentSlot: number): void {
  const cutoff = currentSlot - RECENT_WINDOW_SLOTS;
  let drop = 0;
  while (drop < stats.recent.length && stats.recent[drop].slot < cutoff) {
    drop++;
  }
  if (drop > 0) stats.recent.splice(0, drop);
}

function estimateNetSell(
  curve: Curve,
  tokenAmount: bigint,
  curveFeeBps: bigint,
  txFee: bigint,
): { grossAfterCurveFee: bigint; netOut: bigint } {
  if (
    tokenAmount <= 0n ||
    curve.virtual_token_reserves <= 0n ||
    curve.virtual_quote_reserves <= 0n
  ) {
    return { grossAfterCurveFee: 0n, netOut: 0n };
  }
  const grossSol =
    (curve.virtual_quote_reserves * tokenAmount) /
    (curve.virtual_token_reserves + tokenAmount);
  const afterCurveFee = (grossSol * (BPS - curveFeeBps)) / BPS;
  const netOut = afterCurveFee > txFee ? afterCurveFee - txFee : 0n;
  return { grossAfterCurveFee: afterCurveFee, netOut };
}

function scoreEntry(
  curve: Curve,
  stats: MintStats,
  currentSlot: number,
  maxBuy: bigint,
): bigint {
  if (curve.complete) return -1n;
  if (curve.created_slot === null) return -1n;
  const age = currentSlot - curve.created_slot;
  if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) return -1n;

  if (
    curve.real_quote_reserves < MIN_REAL_RESERVE ||
    curve.real_quote_reserves > MAX_REAL_RESERVE
  ) {
    return -1n;
  }
  if (maxBuy < MIN_BUY_LAMPORTS) return -1n;

  if (stats.buyers.size < MIN_DISTINCT_BUYERS) return -1n;
  if (stats.sellCount < MIN_SELL_COUNT) return -1n;
  if (stats.buyCount < stats.sellCount + 3) return -1n;
  const netFlow = stats.totalBuySol - stats.totalSellSol;
  if (netFlow < MIN_NET_SOL_FLOW) return -1n;
  if (stats.totalBuySol <= 0n) return -1n;
  if (stats.totalSellSol * BPS < stats.totalBuySol * MIN_SELL_BUY_RATIO_BPS) {
    return -1n;
  }
  if (stats.maxBuyerSol * BPS > stats.totalBuySol * MAX_SINGLE_BUYER_BPS) {
    return -1n;
  }
  if (curve.real_quote_reserves * BPS < stats.peakRealReserve * NEAR_PEAK_BPS) {
    return -1n;
  }

  pruneRecent(stats, currentSlot);
  let recentBuys = 0;
  let recentBuySol = 0n;
  let recentSellSol = 0n;
  for (const r of stats.recent) {
    if (r.isBuy) {
      recentBuys++;
      recentBuySol += r.sol;
    } else {
      recentSellSol += r.sol;
    }
  }
  if (recentBuys < MIN_RECENT_BUYS || recentBuySol * 10n < recentSellSol * 8n) return -1n;

  const recentNet = recentBuySol > recentSellSol ? recentBuySol - recentSellSol : 0n;
  return curve.real_quote_reserves + recentNet;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const curveFeeBps = BigInt(
      state.hello.fees.protocol_bps_fallback +
        state.hello.fees.creator_bps_fallback,
    );
    const txFee = state.txFeeLamports();

    // Update fill-driven tracker state
    for (const fill of batch.fills) {
      const tr = trackers.get(fill.mint);
      if (fill.side === 'buy' && fill.status === 'filled') {
        if (tr === undefined) {
          trackers.set(fill.mint, {
            entrySlot: fill.slot,
            tp1Sent: false,
            tp1Filled: false,
            peakValuePerToken: 0n,
          });
        }
      } else if (fill.side === 'sell' && tr !== undefined) {
        if (fill.status === 'filled' && tr.tp1Sent && !tr.tp1Filled) {
          tr.tp1Filled = true;
        } else if (fill.status !== 'filled' && tr.tp1Sent && !tr.tp1Filled) {
          tr.tp1Sent = false;
        }
      }
    }

    // Remove trackers for closed positions
    for (const mint of trackers.keys()) {
      if (!state.positions.has(mint)) {
        trackers.delete(mint);
      }
    }

    // Ingest slot events into per-mint stats
    for (const ev of batch.events) {
      if (ev.event === 'TradeEvent') {
        const s = getOrCreateStats(ev.mint);
        const sol = BigInt(ev.quote_amount);
        if (ev.is_buy) {
          s.buyCount++;
          s.totalBuySol += sol;
          const prev = s.buyers.get(ev.user) ?? 0n;
          const next = prev + sol;
          s.buyers.set(ev.user, next);
          if (next > s.maxBuyerSol) s.maxBuyerSol = next;
        } else {
          s.sellCount++;
          s.totalSellSol += sol;
        }
        s.recent.push({ slot: ev.slot, isBuy: ev.is_buy, sol });
        const rq = BigInt(ev.real_quote_reserves);
        if (rq > s.peakRealReserve) s.peakRealReserve = rq;
        pruneRecent(s, batch.slot);
      }
    }

    const pendingMints = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      pendingMints.add(p.order.mint);
    }

    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;

    // 1. Evaluate exits for open positions first
    for (const [mint, holding] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (pendingMints.has(mint)) continue;

      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;

      let tr = trackers.get(mint);
      if (tr === undefined) {
        tr = {
          entrySlot: batch.slot,
          tp1Sent: false,
          tp1Filled: false,
          peakValuePerToken: 0n,
        };
        trackers.set(mint, tr);
      }

      const { grossAfterCurveFee, netOut } = estimateNetSell(
        curve,
        holding.token_amount,
        curveFeeBps,
        txFee,
      );
      if (grossAfterCurveFee <= txFee) continue;

      const valuePerToken =
        (grossAfterCurveFee * PRICE_SCALE) / holding.token_amount;
      if (valuePerToken > tr.peakValuePerToken) {
        tr.peakValuePerToken = valuePerToken;
      }

      const cost = holding.cost_lamports > 0n ? holding.cost_lamports : 1n;
      const returnBps = (netOut * BPS) / cost;
      const heldSlots = batch.slot - tr.entrySlot;

      let sellAmount = 0n;
      let slippage = NORMAL_SLIPPAGE_BPS;

      if (returnBps <= STOP_LOSS_BPS) {
        sellAmount = holding.token_amount;
        slippage = URGENT_SLIPPAGE_BPS;
      } else if (returnBps >= TP2_BPS) {
        sellAmount = holding.token_amount;
      } else if (
        tr.tp1Filled &&
        returnBps >= TRAIL_START_BPS &&
        tr.peakValuePerToken > 0n &&
        valuePerToken * BPS <= tr.peakValuePerToken * TRAIL_KEEP_BPS
      ) {
        sellAmount = holding.token_amount;
        slippage = URGENT_SLIPPAGE_BPS;
      } else if (!tr.tp1Sent && returnBps >= TP1_BPS) {
        sellAmount = holding.token_amount / 2n;
        if (sellAmount > 0n) tr.tp1Sent = true;
      } else if (
        !tr.tp1Filled &&
        heldSlots >= TIME_STOP_SLOTS &&
        returnBps < TIME_STOP_MAX_BPS
      ) {
        sellAmount = holding.token_amount;
      }

      if (sellAmount > 0n) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: sellAmount,
          max_slippage_bps: slippage,
        });
        pendingMints.add(mint);
      }
    }

    // 2. Evaluate new entries when position slots & cash allow
    let committed = state.committedPositionCount();
    const maxPositions = state.hello.caps.max_open_positions;
    let freeCash = state.freeCashLamports();

    if (committed < maxPositions && orders.length < maxOrders) {
      const candidates: Array<{ mint: Pubkey; score: bigint; buyAmt: bigint }> =
        [];

      for (const [mint, curve] of state.curves) {
        if (enteredMints.has(mint)) continue;
        if (state.positions.has(mint) || pendingMints.has(mint)) continue;
        const stats = mintStats.get(mint);
        if (stats === undefined) continue;

        const rawCap = state.maxBuyLamports(mint);
        const cap = (rawCap * CAP_BUFFER_BPS) / BPS;
        const score = scoreEntry(curve, stats, batch.slot, cap);
        if (score < 0n) continue;

        const buyAmt = cap < TARGET_BUY_LAMPORTS ? cap : TARGET_BUY_LAMPORTS;
        if (buyAmt < MIN_BUY_LAMPORTS) continue;
        candidates.push({ mint, score, buyAmt });
      }

      candidates.sort((a, b) =>
        b.score > a.score ? 1 : b.score < a.score ? -1 : a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0,
      );

      for (const c of candidates) {
        if (committed >= maxPositions || orders.length >= maxOrders) break;
        const needed = c.buyAmt + txFee;
        if (freeCash < needed) continue;

        orders.push({
          side: 'buy',
          mint: c.mint,
          quote_lamports: c.buyAmt,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
        enteredMints.add(c.mint);
        pendingMints.add(c.mint);
        committed++;
        freeCash -= needed;
      }
    }

    return orders;
  },
});

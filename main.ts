// TigaDetik — an early-tape launch sniper for the pump.fun paper replay.
//
// Idea, in one paragraph: most pump.fun coins are decided in their first few
// slots. A launch that already holds a little real SOL, has a few real trades
// from only a handful of distinct wallets, and whose creator has not sold yet
// is worth a small probe. If the tape keeps rising after the probe, add to the
// winner; if it does not, get out within ten slots. Winners are trimmed early
// (a quarter off at +10%) so a round trip that goes nowhere costs little more
// than the curve and transaction fees, while a launch that keeps running is
// held to +30% before the rest is sold.
//
// Why the filters are what they are (measured on the kit's dev window):
//   - real SOL >= 2: the per-reply buy cap is 1% of the real reserve, so
//     below 2 SOL a buy is too small to cover its own transaction fee, and
//     on the dev window 2 SOL filtered better than 1 or 3 SOL.
//   - at least 3 trades, at most 3 distinct non-creator buyers: launches
//     bundled by many wallets in the first slot are usually a creator cluster
//     waiting to dump; a launch nobody has touched yet has no tape to read.
//   - creator sold -> skip: the person who made the coin selling it in its
//     first slots is the single most reliable rug signal in the tape.
//   - max age 3 slots: after that the launch is no longer a launch, it is
//     just another coin, and the early-tape edge is gone.
//   - adds of 0.1 SOL when the price is at least 5% above the last buy:
//     pyramiding only into strength, never averaging down.
//   - max hold 10 slots: the edge, if it exists, shows up immediately;
//     holding longer on this window only added drawdown.
//
// Everything here is a pure function of the batches the harness sends: no
// clock, no randomness, no environment, no I/O. The two graded executions
// therefore produce byte-identical action logs.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const BPS = 10_000n;
const LAMPORTS_PER_SOL = 1_000_000_000n;

// ---- tuned constants (see the header for why) ----
const FIRST_STAKE = 50_000_000n; // 0.05 SOL first probe per coin
const ADD_STAKE = 100_000_000n; // 0.1 SOL per pyramid add
const MIN_BUY = 5_000_000n; // 0.005 SOL: smallest buy worth a tx fee
const MAX_AGE_SLOTS = 3; // first buy only while the launch is this young
const ADD_DELAY_SLOTS = 2; // at least this long between buys on one coin
const MAX_ADDS = 2;
const ADD_STEP_BPS = 500n; // add only when price is >= +5% above last buy
const MIN_REAL_SOL = 2n * LAMPORTS_PER_SOL; // 2 SOL in the curve
const MAX_REAL_SOL = 30n * LAMPORTS_PER_SOL; // 30 SOL: past that it is not a launch
const MAX_DEV_BUY = 2_500_000_000n; // creator's own buy in the create slot, at most 2.5 SOL
const MIN_TRADES = 3;
const MAX_BUYERS = 3; // distinct non-creator buyers, at most
const TP1_BPS = 1_000n; // +10%: trim a quarter of the position
const TP1_PART_BPS = 2_500n; // 25% of the tokens
const TP_BPS = 3_000n; // +30%: sell the rest
const SL_BPS = 2_000n; // -20%: cut the loser (0 once the trim is taken)
const MAX_HOLD_SLOTS = 10;
const FLOW_WINDOW_SLOTS = 10; // recent-flow window for adds
const WIDE_SLIPPAGE_BPS = 10_000; // never refuse a fill for a price move in the latency
const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Tape {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  buysSent: number;
  spentSent: bigint;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  tookTrim: boolean;
  devSoldAtOpen: boolean;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const selling = new Set<Pubkey>();

function newTape(e: Extract<Batch['events'][number], { event: 'CreateEvent' }>): Tape {
  return {
    mint: e.mint,
    createSlot: e.slot,
    creator: e.creator,
    vq0: BigInt(e.virtual_quote_reserves),
    vt0: BigInt(e.virtual_token_reserves),
    devBuy: 0n,
    trades: 0,
    buyers: new Set(),
    bought: 0n,
    soldByOthers: 0n,
    bigSellBps: 0n,
    devSold: false,
    lastTradeSlot: e.slot,
    recent: [],
    buysSent: 0,
    spentSent: 0n,
    lastBuyVq: 0n,
    lastBuyVt: 1n,
    lastBuySlot: 0,
    done: false,
    complete: false,
  };
}

function readTape(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      tapes.set(e.mint, newTape(e));
    } else if (e.event === 'TradeEvent') {
      const t = tapes.get(e.mint);
      if (t === undefined) continue;
      const sol = BigInt(e.sol_amount);
      t.trades += 1;
      t.lastTradeSlot = e.slot;
      t.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
      const isDev = e.user === t.creator;
      if (e.is_buy) {
        t.bought += sol;
        if (isDev && e.slot === t.createSlot) t.devBuy += sol;
        else if (!isDev) t.buyers.add(e.user);
      } else if (isDev) {
        t.devSold = true;
      } else {
        t.soldByOthers += sol;
        const rqBefore = BigInt(e.real_quote_reserves) + sol;
        if (rqBefore > 0n) {
          const bps = (sol * BPS) / rqBefore;
          if (bps > t.bigSellBps) t.bigSellBps = bps;
        }
      }
    } else {
      const t = tapes.get(e.mint);
      if (t !== undefined) {
        t.complete = true;
        t.done = true;
      }
    }
  }
}

/** Net SOL bought minus sold over the last FLOW_WINDOW_SLOTS slots. */
function recentNetFlow(t: Tape, slot: number): bigint {
  const from = slot - FLOW_WINDOW_SLOTS;
  let drop = 0;
  while (drop < t.recent.length && t.recent[drop]!.slot <= from) drop++;
  if (drop > 0) t.recent.splice(0, drop);
  let net = 0n;
  for (const tick of t.recent) net += tick.isBuy ? tick.sol : -tick.sol;
  return net;
}

function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

await runBot({
  onBatch(state, batch) {
    readTape(batch);
    const orders: OrderInput[] = [];
    const replyCap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) {
      marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
    }

    // Fills settle the bookkeeping: a filled buy opens a Held record, a
    // harness close (complete / flatten / write-off) removes it.
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        held.delete(f.mint);
        selling.delete(f.mint);
        continue;
      }
      const h = held.get(f.mint);
      if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
      if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
        held.set(f.mint, {
          openedSlot: f.slot,
          txPaid: BigInt(f.tx_fee_lamports),
          tookTrim: false,
          devSoldAtOpen: tapes.get(f.mint)?.devSold ?? false,
        });
      }
    }
    for (const mint of [...selling]) {
      if (!hasPending(state, mint, 'sell')) selling.delete(mint);
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) {
        held.delete(mint);
      }
    }

    // ---- exits first: trim, take profit, stop, hold limit, creator sell ----
    for (const [mint, pos] of state.positions) {
      if (orders.length >= replyCap) break;
      if (selling.has(mint)) continue;
      const tape = tapes.get(mint);
      let h = held.get(mint);
      if (h === undefined) {
        h = { openedSlot: state.slot, txPaid: tx, tookTrim: false, devSoldAtOpen: tape?.devSold ?? false };
        held.set(mint, h);
      }
      let mk = marks.get(mint);
      if (mk === undefined) {
        const curve = state.curves.get(mint);
        if (curve === undefined) continue;
        mk = { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
      }
      const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
      const basis = pos.cost_lamports + h.txPaid;
      if (basis > 0n) {
        // Trim a quarter at +10%, then let the rest ride with its stop at cost.
        if (!h.tookTrim && value * BPS >= basis * (BPS + TP1_BPS)) {
          const part = (pos.token_amount * TP1_PART_BPS) / BPS;
          if (part > 0n && part < pos.token_amount) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: WIDE_SLIPPAGE_BPS });
            selling.add(mint);
            h.tookTrim = true;
            if (tape !== undefined) tape.done = true;
            continue;
          }
        }
        if (value * BPS >= basis * (BPS + TP_BPS)) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: WIDE_SLIPPAGE_BPS });
          selling.add(mint);
          if (tape !== undefined) tape.done = true;
          continue;
        }
        const stopBps = h.tookTrim ? 0n : SL_BPS;
        if (value * BPS <= basis * (BPS - stopBps)) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: WIDE_SLIPPAGE_BPS });
          selling.add(mint);
          if (tape !== undefined) tape.done = true;
          continue;
        }
      }
      let exit = false;
      if (state.slot - h.openedSlot >= MAX_HOLD_SLOTS) exit = true;
      if (tape !== undefined && tape.devSold && !h.devSoldAtOpen) exit = true;
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: WIDE_SLIPPAGE_BPS });
      selling.add(mint);
      if (tape !== undefined) tape.done = true;
    }

    // ---- entries and pyramid adds ----
    let free = state.freeCashLamports() - tx * BigInt(orders.length);
    let open = state.committedPositionCount();
    for (const tape of tapes.values()) {
      if (orders.length >= replyCap) break;
      if (tape.done || tape.complete) continue;
      const age = state.slot - tape.createSlot;
      const isAdd = tape.buysSent > 0;
      if (!isAdd && age > MAX_AGE_SLOTS) {
        tape.done = true;
        continue;
      }
      const curve = state.curves.get(tape.mint);
      if (curve === undefined || curve.complete) continue;
      if (tape.devSold) {
        if (!isAdd) tape.done = true;
        continue;
      }
      if (isAdd) {
        if (tape.buysSent > MAX_ADDS) continue;
        if (!state.positions.has(tape.mint) || selling.has(tape.mint) || hasPending(state, tape.mint, 'buy')) continue;
        if (state.slot - tape.lastBuySlot < ADD_DELAY_SLOTS) continue;
        // Only add into strength: price at least 5% above the last buy.
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (vq * tape.lastBuyVt * BPS < tape.lastBuyVq * vt * (BPS + ADD_STEP_BPS)) continue;
        if (recentNetFlow(tape, state.slot) < 0n) continue;
        const cap = state.maxBuyLamports(tape.mint);
        const amount = ADD_STAKE < cap ? ADD_STAKE : cap;
        if (amount < MIN_BUY || free < amount + tx * 6n) continue;
        orders.push({ side: 'buy', mint: tape.mint, quote_lamports: amount, max_slippage_bps: WIDE_SLIPPAGE_BPS });
        free -= amount + tx;
        tape.buysSent += 1;
        tape.spentSent += amount;
        tape.lastBuyVq = vq;
        tape.lastBuyVt = vt;
        tape.lastBuySlot = state.slot;
        continue;
      }
      // First buy: the rug filter.
      if (open >= state.hello.caps.max_open_positions) continue;
      const rq = curve.real_quote_reserves;
      if (rq < MIN_REAL_SOL || rq > MAX_REAL_SOL) continue;
      if (tape.devBuy > MAX_DEV_BUY) continue;
      if (tape.trades < MIN_TRADES || tape.buyers.size > MAX_BUYERS) continue;
      const room = FIRST_STAKE - tape.spentSent;
      if (room < MIN_BUY) continue;
      const cap = state.maxBuyLamports(tape.mint);
      const amount = room < cap ? room : cap;
      if (amount < MIN_BUY) continue;
      if (free < amount + tx * 6n) continue;
      orders.push({ side: 'buy', mint: tape.mint, quote_lamports: amount, max_slippage_bps: WIDE_SLIPPAGE_BPS });
      free -= amount + tx;
      tape.buysSent += 1;
      tape.spentSent += amount;
      tape.lastBuyVq = curve.virtual_quote_reserves;
      tape.lastBuyVt = curve.virtual_token_reserves;
      tape.lastBuySlot = state.slot;
      open += 1;
    }
    return orders;
  },
});

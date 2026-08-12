// js/whale-discovery.js
//
// Auto-discovers and ranks the top pump.fun traders, entirely in the
// browser, using your Helius key. No server required.
//
// METHOD (heuristic, not an official ranking — pump.fun doesn't expose one):
//  1. Pull the most recent signatures against the pump.fun program.
//  2. Parse them with Helius's Enhanced Transactions API (decodes
//     token + SOL transfers per tx without you writing a Borsh decoder).
//  3. Reconstruct each wallet's buy/sell lots per mint (FIFO cost basis)
//     to compute realized PnL on CLOSED round trips only.
//  4. Score = weighted(realized PnL, win rate, trade count), with a
//     minimum closed-trade floor so lucky one-off trades don't rank.
//  5. Upsert the top 50 into `whales`, followed by default — the user
//     excludes individual whales manually via the leaderboard toggle.
//
// HONEST LIMITATIONS:
//  - This scans a recent window of activity (last ~1000 pump.fun
//    transactions), not a true rolling 30-day archive — a full archive
//    needs a persistent indexer (a real backend), which was explicitly
//    ruled out here in favor of "runs in the browser."
//  - PnL is in SOL, converted to USD via a live SOL/USD price fetch.
//  - Helius free tier has rate limits; a full scan uses ~10-15 requests.

const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MIN_CLOSED_TRADES = 3; // floor to exclude lucky one-offs

async function fetchSolUsdPrice() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const j = await r.json();
    return j?.solana?.usd || 0;
  } catch {
    return 0;
  }
}

async function fetchRecentSignatures(heliusKey, limit = 1000) {
  const url = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getSignaturesForAddress",
    params: [PUMPFUN_PROGRAM_ID, { limit: Math.min(limit, 1000) }],
  };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  return (j.result || []).map((s) => s.signature);
}

async function fetchParsedTransactions(heliusKey, signatures) {
  const url = `https://api.helius.xyz/v0/transactions?api-key=${heliusKey}`;
  const out = [];
  for (let i = 0; i < signatures.length; i += 100) {
    const batch = signatures.slice(i, i + 100);
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: batch }),
    });
    if (!r.ok) continue;
    const j = await r.json();
    if (Array.isArray(j)) out.push(...j);
  }
  return out;
}

/**
 * Reconstructs per-wallet closed round trips (FIFO cost basis) and
 * scores each wallet. Returns an array sorted best-first.
 */
function scoreWallets(parsedTxs) {
  // wallet -> mint -> [{qty, costSol, ts}]  (open buy lots, FIFO)
  const openLots = new Map();
  // wallet -> [{pnlSol, ts}]
  const closedTrades = new Map();

  function lotsFor(wallet, mint) {
    if (!openLots.has(wallet)) openLots.set(wallet, new Map());
    const m = openLots.get(wallet);
    if (!m.has(mint)) m.set(mint, []);
    return m.get(mint);
  }
  function recordClose(wallet, pnlSol, ts) {
    if (!closedTrades.has(wallet)) closedTrades.set(wallet, []);
    closedTrades.get(wallet).push({ pnlSol, ts });
  }

  for (const tx of parsedTxs) {
    const feePayer = tx.feePayer;
    if (!feePayer) continue;
    const ts = (tx.timestamp || 0) * 1000;

    const solOut = (tx.nativeTransfers || [])
      .filter((t) => t.fromUserAccount === feePayer)
      .reduce((s, t) => s + t.amount, 0) / 1e9;
    const solIn = (tx.nativeTransfers || [])
      .filter((t) => t.toUserAccount === feePayer)
      .reduce((s, t) => s + t.amount, 0) / 1e9;

    const tokenIn = (tx.tokenTransfers || []).filter((t) => t.toUserAccount === feePayer && t.mint !== SOL_MINT);
    const tokenOut = (tx.tokenTransfers || []).filter((t) => t.fromUserAccount === feePayer && t.mint !== SOL_MINT);

    // Buy: wallet spent SOL, received a token
    if (solOut > 0 && tokenIn.length > 0) {
      for (const t of tokenIn) {
        lotsFor(feePayer, t.mint).push({ qty: t.tokenAmount, costSol: solOut * (t.tokenAmount / tokenIn.reduce((s, x) => s + x.tokenAmount, 0)), ts });
      }
    }
    // Sell: wallet sent a token, received SOL — consume FIFO lots
    if (solIn > 0 && tokenOut.length > 0) {
      for (const t of tokenOut) {
        const lots = lotsFor(feePayer, t.mint);
        let remaining = t.tokenAmount;
        let costBasis = 0;
        while (remaining > 0 && lots.length > 0) {
          const lot = lots[0];
          const take = Math.min(lot.qty, remaining);
          costBasis += lot.costSol * (take / lot.qty);
          lot.qty -= take;
          lot.costSol -= lot.costSol * (take / lot.qty + Number.EPSILON) || 0;
          remaining -= take;
          if (lot.qty <= 0) lots.shift();
        }
        const proceeds = solIn * (t.tokenAmount / tokenOut.reduce((s, x) => s + x.tokenAmount, 0));
        recordClose(feePayer, proceeds - costBasis, ts);
      }
    }
  }

  const results = [];
  for (const [wallet, trades] of closedTrades.entries()) {
    if (trades.length < MIN_CLOSED_TRADES) continue;
    const pnlSol = trades.reduce((s, t) => s + t.pnlSol, 0);
    const wins = trades.filter((t) => t.pnlSol > 0).length;
    const winRate = (wins / trades.length) * 100;
    // simple weighted score: realized PnL dominates, win rate and
    // trade frequency are tie-breakers among profitable wallets
    const score = pnlSol * 10 + winRate * 0.5 + Math.min(trades.length, 50) * 0.2;
    results.push({ wallet, pnlSol, winRate, tradeCount: trades.length, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

async function discoverTopWhales(heliusKey, sb, onProgress) {
  onProgress?.("Fetching recent pump.fun activity…");
  const sigs = await fetchRecentSignatures(heliusKey, 1000);
  if (sigs.length === 0) throw new Error("No recent pump.fun activity returned — try again shortly.");

  onProgress?.(`Parsing ${sigs.length} transactions…`);
  const parsed = await fetchParsedTransactions(heliusKey, sigs);

  onProgress?.("Scoring wallets…");
  const ranked = scoreWallets(parsed).slice(0, 50);
  if (ranked.length === 0) {
    throw new Error("No wallets met the minimum closed-trade floor yet — try again after more activity.");
  }

  const solUsd = await fetchSolUsdPrice();

  onProgress?.("Saving top 50…");
  for (let i = 0; i < ranked.length; i++) {
    const w = ranked[i];
    const short = w.wallet.slice(0, 4) + "…" + w.wallet.slice(-4);
    const { data: existing } = await sb.from("whales").select("id,is_followed").eq("address", w.wallet).maybeSingle();
    await sb.from("whales").upsert(
      {
        address: w.wallet,
        name: existing ? undefined : short,
        pnl_30d_usd: Math.round(w.pnlSol * solUsd * 100) / 100,
        win_rate_pct: Math.round(w.winRate * 10) / 10,
        trade_count: w.tradeCount,
        is_hot_streak: w.winRate >= 65,
        is_followed: existing ? existing.is_followed : true, // auto-included; user excludes manually
        rank: i + 1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "address" }
    );
  }

  onProgress?.("Done");
  return ranked.length;
}

window.discoverTopWhales = discoverTopWhales;

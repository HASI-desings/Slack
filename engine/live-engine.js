// js/live-engine.js
//
// Runs entirely in the browser tab — no server, no VPS, no Rust process.
// This REPLACES engine/src/lib.rs's ingestion role. The overlap-scanner
// and whale-isolated sell logic are ported here in JS; engine/ is no
// longer required for the browser-only setup (kept in the zip for
// reference / for a future real backend, but unused by index.html now).
//
// HONEST LIMITATION: this only runs while the browser tab is open and
// active. Closing the tab, locking the phone, or losing wifi stops
// tracking. There is no background execution in a plain browser tab —
// that would require a real server process (which is what you asked to
// remove). If you want 24/7 tracking later, this file is what would move
// to a small always-on server.

const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

class OverlapScanner {
  constructor(windowMs = 60000, threshold = 2) {
    this.windowMs = windowMs;
    this.threshold = threshold;
    this.recentBuys = new Map(); // mint -> [{whale, at}]
  }
  ingest(mint, whale, at = Date.now()) {
    const list = this.recentBuys.get(mint) || [];
    list.push({ whale, at });
    const cutoff = at - this.windowMs;
    const pruned = list.filter((b) => b.at >= cutoff);
    this.recentBuys.set(mint, pruned);
    const unique = [...new Set(pruned.map((b) => b.whale))];
    return unique.length >= this.threshold ? unique : null;
  }
}

class LiveEngine {
  constructor(sb) {
    this.sb = sb;
    this.connection = null;
    this.subscriptionId = null;
    this.running = false;
    this.scanner = new OverlapScanner();
    this.followedWhales = new Map(); // address -> whale row
    this.onStatusChange = null; // optional callback(status: string)
  }

  async start(heliusApiKey) {
    if (this.running) return;
    if (!heliusApiKey) throw new Error("Missing Helius API key");
    if (!window.solanaWeb3) throw new Error("@solana/web3.js failed to load");

    await this._loadFollowedWhales();
    if (this.followedWhales.size === 0) {
      throw new Error("No followed whales yet — add whale addresses on the Leaderboard tab first.");
    }

    const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
    const httpUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
    this.connection = new solanaWeb3.Connection(httpUrl, { wsEndpoint: wsUrl, commitment: "confirmed" });

    const programId = new solanaWeb3.PublicKey(PUMPFUN_PROGRAM_ID);
    this.subscriptionId = this.connection.onLogs(
      programId,
      (logInfo) => this._handleLog(logInfo).catch((e) => console.error("[live-engine]", e)),
      "confirmed"
    );

    this.running = true;
    this._setStatus("live");
  }

  async stop() {
    if (this.connection && this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId);
    }
    this.running = false;
    this.subscriptionId = null;
    this._setStatus("stopped");
  }

  _setStatus(status) {
    if (this.onStatusChange) this.onStatusChange(status);
  }

  async _loadFollowedWhales() {
    const { data } = await this.sb.from("whales").select("*").eq("is_followed", true);
    this.followedWhales = new Map((data || []).map((w) => [w.address, w]));
  }

  async _handleLog(logInfo) {
    const { signature, logs, err } = logInfo;
    if (err) return;

    const isBuy = logs.some((l) => l.includes("Instruction: Buy"));
    const isSell = logs.some((l) => l.includes("Instruction: Sell"));
    if (!isBuy && !isSell) return;

    const tx = await this.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
    if (!tx || !tx.transaction) return;

    const feePayer = tx.transaction.message.accountKeys[0].pubkey.toBase58();
    const whale = this.followedWhales.get(feePayer);
    if (!whale) return; // not a whale we track — ignore, don't spam the feed

    const mint = this._extractMint(tx);
    if (!mint) return;

    if (isBuy) await this._onWhaleBuy(whale, mint, signature);
    if (isSell) await this._onWhaleSell(whale, mint, signature);
  }

  _extractMint(tx) {
    const balances = tx.meta && (tx.meta.postTokenBalances || []);
    const nonSol = balances.find((b) => b.mint && b.mint !== "So11111111111111111111111111111111111111112");
    return nonSol ? nonSol.mint : null;
  }

  async _onWhaleBuy(whale, mint, signature) {
    const overlap = this.scanner.ingest(mint, whale.address);
    const triggerLabel = overlap && overlap.length > 1 ? `overlap x${overlap.length}` : whale.name;

    await this.sb.from("activity_feed").insert({
      icon: overlap && overlap.length > 1 ? "🔥" : "🐋",
      message: `<b>${whale.name}</b> bought a token${overlap && overlap.length > 1 ? ` · ${overlap.length} tracked whales bought within 60s → overlap triggered` : ""}`,
      detail: signature.slice(0, 12) + "…",
    });

    // Mirrors the buy as an open position tied to this trigger — whale
    // isolation on the sell side depends on trigger_whale_id being set here.
    await this.sb.from("positions").insert({
      token_symbol: mint.slice(0, 4).toUpperCase(),
      mint_address: mint,
      trigger_whale_id: whale.id,
      trigger_label: triggerLabel,
      entry_price: 0,
      current_price: 0,
      sol_invested: 0,
      pnl_pct: 0,
      status: "open",
    });
  }

  async _onWhaleSell(whale, mint, signature) {
    // Whale-isolated close: only close positions whose trigger_whale_id
    // matches THIS whale. A different tracked whale selling the same
    // mint must never touch this position — ported from engine/src/lib.rs §3.3.
    const { data: openPositions } = await this.sb
      .from("positions")
      .select("*")
      .eq("mint_address", mint)
      .eq("status", "open")
      .eq("trigger_whale_id", whale.id);

    for (const pos of openPositions || []) {
      await this.sb.from("positions").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", pos.id);
    }

    await this.sb.from("activity_feed").insert({
      icon: "📤",
      message: `<b>${whale.name}</b> exited a position — mirrored sell closed`,
      detail: signature.slice(0, 12) + "…",
    });
  }
}

window.LiveEngine = LiveEngine;

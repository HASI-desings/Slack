// lib/template/codec.ts
//
// Shareable template codes (§4): { whaleAddresses[], riskParams }
// -> compressed payload stored server-side, keyed by a short human code
// like "WHALE-9A3B". The code itself is short; the full payload lives
// server-side, not crammed into the code.

export interface RiskParams {
  maxSolPerTrade: number;
  maxSlippagePct: number;
  takeProfitPct: number;
  stopLossPct: number;
  jitoTipBaseSol: number;
  jitoTipMaxSol: number;
  overlapThreshold: number;
  dailyDrawdownCircuitBreakerPct: number;
}

export interface Template {
  whaleAddresses: string[];
  riskParams: RiskParams;
}

function randomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let out = "";
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return `WHALE-${out}`;
}

// In-memory stand-in for the server-side key-value store.
// TODO: replace with the actual backend persistence layer.
const templateStore = new Map<string, Template>();

export async function createTemplateCode(template: Template): Promise<string> {
  let code = randomCode();
  while (templateStore.has(code)) code = randomCode(); // avoid collision
  templateStore.set(code, template);
  return code;
}

export async function resolveTemplateCode(code: string): Promise<Template | null> {
  return templateStore.get(code.toUpperCase()) ?? null;
}

/** Human-readable preview shown before a user commits to loading a template. */
export function previewTemplate(t: Template): string {
  return `This template follows ${t.whaleAddresses.length} whales, max ${t.riskParams.maxSolPerTrade} SOL/trade, ${t.riskParams.takeProfitPct}% TP, ${t.riskParams.stopLossPct}% SL.`;
}

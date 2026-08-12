// lib/wallet/adapter.ts
//
// Thin abstraction so the underlying signer provider (Privy today,
// ZeroDev/session-keys later) can be swapped without touching trade logic.
//
// CRITICAL SAFETY CONSTRAINT (see build spec §1.3):
// This app auto-executes trades on the user's behalf. The signer must
// ALWAYS be scoped — never request or store a broad/unscoped signer.

export interface SessionKeyScope {
  maxSolPerTx: number;
  allowedProgramIds: string[]; // pump.fun, Raydium, Jito tip accounts only
  expiresAt: number; // unix ms — time-boxed, never indefinite
}

export interface WalletAdapter {
  /** Human-readable label for the Settings "scope viewer". */
  describeScope(): string;
  /** Sign and send a transaction, enforcing scope before submission. */
  signAndSend(txBase64: string, solAmount: number, programId: string): Promise<{ signature: string }>;
  /** Immediately invalidate the delegated signer. */
  revoke(): Promise<void>;
  isExpired(): boolean;
}

export class ScopedSessionKeyAdapter implements WalletAdapter {
  constructor(private scope: SessionKeyScope, private revoked = false) {}

  describeScope(): string {
    const hrs = Math.max(0, Math.round((this.scope.expiresAt - Date.now()) / 3_600_000));
    return `Max ${this.scope.maxSolPerTx} SOL/tx · ${this.scope.allowedProgramIds.length} allowed programs · expires in ${hrs}h`;
  }

  isExpired(): boolean {
    return this.revoked || Date.now() > this.scope.expiresAt;
  }

  async signAndSend(txBase64: string, solAmount: number, programId: string) {
    // Fail-closed checks — never fail open into an uncontrolled trade.
    if (this.isExpired()) throw new Error("session key expired or revoked");
    if (solAmount > this.scope.maxSolPerTx) throw new Error("exceeds per-transaction SOL cap");
    if (!this.scope.allowedProgramIds.includes(programId)) throw new Error("program not in allow-list");

    // TODO: requires live Privy/ZeroDev session-key signer wired to a
    // funded embedded wallet. Stubbed here — do not treat as a working
    // success path.
    throw new Error("signAndSend: no signer provider configured (stub)");
  }

  async revoke() {
    this.revoked = true;
  }
}

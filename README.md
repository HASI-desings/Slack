# Slack — Whale Copy Trading

A mobile-first, iOS-installable PWA for following pump.fun's most profitable
wallets ("whales") and mirroring their trades with configurable risk controls.

## What's in this zip

```
slack-app/
├── index.html          ← the working app (open this in a browser or install it)
├── manifest.json        ← PWA manifest, all icon sizes wired in
├── sw.js                 ← service worker (shell-only cache, never caches live data)
├── icons/                ← generated app icon, 16px → 1024px, incl. maskable
├── engine/                ← Rust decision engine (overlap scanner + whale-isolated sell logic)
│   ├── src/lib.rs
│   └── Cargo.toml
└── lib/
    ├── wallet/adapter.ts   ← scoped session-key signer abstraction
    └── template/codec.ts    ← shareable template code encode/decode
```

## Try it now

Open `index.html` directly in any browser (or host it anywhere — it's static).
It's connected live to your Supabase project (`bvxljqprdvgrnhrfmhpz`) — no
mock data. Leaderboard, Positions, and the activity feed all read from real
tables and will show empty-state messages until data exists in them. On an
iPhone, open it in Safari and you'll get the custom "Add to Home Screen"
sheet; once added, it launches full-screen with the app icon and no browser
chrome.

## Supabase

Schema lives in your project and includes: `whales`, `positions`,
`activity_feed`, `api_keys`, `risk_settings`. All previous SQL in the
project was dropped and replaced with this clean schema. RLS is enabled
with public read/write policies since there's no user-account system yet —
tighten these once auth is added.

To populate real data, either wire up the Rust engine (`engine/`) to insert
into these tables as it ingests whale activity, or insert rows manually
while testing.

### API keys (Settings page)

Each key has its own card with free-tier signup steps built into the UI:

| Key | Where to get it (free) |
|---|---|
| Geyser RPC (Helius) | helius.dev → sign up → Dashboard → copy default API key |
| Jito auth key | jito.wtf → Discord → #searcher-onboarding → request a searcher keypair |
| Privy App ID | privy.io → sign up → Create app → Dashboard → App ID (free up to 1,000 MAUs) |

Keys are saved to the `api_keys` table in Supabase and persist until
replaced — no re-entry needed on future visits. They're stored in plain
text in this MVP; move to Supabase Vault or a server-side secrets store
before handling real funds.

## Design direction

Dark, obsidian-and-phosphor-green aesthetic instead of default fintech
blue/green cards — built for fast decisions at 2am, not a leisurely
dashboard browse. Every screen transition, switch, and tab uses spring-eased
motion (not linear CSS defaults). The icon is a custom glowing bolt-S
monogram on a squircle, generated at every required Apple size including
maskable variants.

## Production-ready vs. stubbed

**Production-ready in this deliverable:**
- Full frontend UI/UX (all 4 screens), PWA installability, manifest, service
  worker, app icon set
- Rust decision engine core logic: overlap scanner, whale-isolated sell
  logic (§3.3 — the part most copy-trade bots get wrong), pre-trade safety
  gates. Includes passing unit tests proving the isolation guarantee.
- Template code encode/decode utility and preview logic
- Wallet adapter interface with scope enforcement (fails closed on expiry,
  cap breach, or disallowed program)

**Requires a live provider account before this touches real money:**
- Geyser gRPC ingestion — needs a paid provider (Helius or
  Triton/Yellowstone); public RPC/WSS cannot deliver the required latency
- Jito Block Engine bundle submission — needs a Jito searcher auth key
- Privy embedded wallet integration — needs a Privy App ID
- Backend persistence for template codes (currently an in-memory stand-in)
- Rug-check heuristic data source (LP lock / mint authority / holder
  concentration) — needs an on-chain data provider

None of the above are faked with success paths — each is either clearly
marked `// TODO: requires <service>` in code or throws explicitly rather
than pretending to succeed.

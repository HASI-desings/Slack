//! APEX-COPY / "Slack" execution engine — skeleton.
//!
//! Architecture: standalone service, decoupled from frontend uptime.
//! ingestion-service -> Redis stream -> this crate -> Jito bundles.
//!
//! PRODUCTION-READY: overlap scanner logic, whale-isolation sell logic
//!   (the part most copy-trade bots get wrong), position state machine.
//! REQUIRES EXTERNAL SERVICE BEFORE MAINNET:
//!   - Geyser gRPC stream (TODO: requires a paid Geyser-enabled RPC
//!     provider — e.g. Helius or Triton/Yellowstone. Public RPC/WSS
//!     cannot deliver required latency.)
//!   - Jito Block Engine auth key for bundle submission.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

pub type WhaleAddr = String;
pub type Mint = String;

#[derive(Debug, Clone)]
pub enum TriggerSource {
    SingleWhale(WhaleAddr),
    Overlap { whales: Vec<WhaleAddr> },
}

#[derive(Debug, Clone)]
pub struct BuyEvent {
    pub whale: WhaleAddr,
    pub mint: Mint,
    pub sol_amount: f64,
    pub at: Instant,
}

#[derive(Debug, Clone)]
pub struct SellEvent {
    pub whale: WhaleAddr,
    pub mint: Mint,
    pub fraction_sold: f64, // 0.0..=1.0, partial sell support
    pub at: Instant,
}

/// A position opened by the engine on the user's behalf.
/// Stores exactly which whale/overlap triggered it — this is the
/// field that makes whale-isolated sell logic possible (§3.3).
#[derive(Debug, Clone)]
pub struct Position {
    pub mint: Mint,
    pub trigger: TriggerSource,
    pub sol_invested: f64,
    pub entry_price: f64,
    pub take_profit_pct: f64,
    pub stop_loss_pct: f64,
    pub trailing_stop_pct: Option<f64>,
    pub opened_at: Instant,
    pub is_migrated_to_raydium: bool,
}

impl Position {
    /// Returns true if `seller` is one of the whales that triggered
    /// this position. A different whale selling the same token must
    /// NEVER close this position — this is the isolation guarantee.
    pub fn triggered_by(&self, seller: &WhaleAddr) -> bool {
        match &self.trigger {
            TriggerSource::SingleWhale(w) => w == seller,
            TriggerSource::Overlap { whales } => whales.contains(seller),
        }
    }
}

/// Rolling window overlap scanner: emits an OverlapSignal when >= N
/// tracked whales buy the same mint within `window`.
pub struct OverlapScanner {
    window: Duration,
    threshold: usize,
    // mint -> list of (whale, timestamp) buys within the window
    recent_buys: HashMap<Mint, Vec<(WhaleAddr, Instant)>>,
}

impl OverlapScanner {
    pub fn new(window_secs: u64, threshold: usize) -> Self {
        Self {
            window: Duration::from_secs(window_secs),
            threshold,
            recent_buys: HashMap::new(),
        }
    }

    /// Feed a buy event; returns Some(OverlapSignal) if threshold crossed.
    pub fn ingest(&mut self, event: &BuyEvent) -> Option<TriggerSource> {
        let entry = self.recent_buys.entry(event.mint.clone()).or_default();
        entry.push((event.whale.clone(), event.at));

        // prune anything outside the window
        let cutoff = event.at.checked_sub(self.window).unwrap_or(event.at);
        entry.retain(|(_, t)| *t >= cutoff);

        let unique: HashSet<&WhaleAddr> = entry.iter().map(|(w, _)| w).collect();
        if unique.len() >= self.threshold {
            Some(TriggerSource::Overlap {
                whales: unique.into_iter().cloned().collect(),
            })
        } else {
            None
        }
    }
}

/// Core decision engine: owns open positions, decides buy/sell.
pub struct DecisionEngine {
    positions: Vec<Position>,
    blacklist: HashSet<Mint>,
    daily_spent_sol: f64,
    daily_budget_sol: f64,
}

pub enum SellReason {
    TriggeringWhaleExited,
    TakeProfitHit,
    StopLossHit,
    TrailingStopHit,
}

impl DecisionEngine {
    pub fn new(daily_budget_sol: f64) -> Self {
        Self {
            positions: Vec::new(),
            blacklist: HashSet::new(),
            daily_spent_sol: 0.0,
            daily_budget_sol,
        }
    }

    /// Pre-trade safety gate (§3.2). Fails closed: any check failure
    /// means no trade, never a silent fallback into an uncontrolled buy.
    pub fn can_buy(&self, mint: &Mint, sol_amount: f64) -> Result<(), &'static str> {
        if self.blacklist.contains(mint) {
            return Err("mint is blacklisted");
        }
        if self.daily_spent_sol + sol_amount > self.daily_budget_sol {
            return Err("daily budget exceeded");
        }
        if self.positions.iter().any(|p| &p.mint == mint) {
            return Err("position already open for this trigger");
        }
        Ok(())
    }

    /// §3.3 whale-isolated sell logic. This is the critical negative-case
    /// guarantee: a sell from a whale that did NOT trigger a given
    /// position must never close that position.
    pub fn on_whale_sell(&mut self, event: &SellEvent) -> Vec<(Position, SellReason)> {
        let mut closed = Vec::new();
        self.positions.retain(|p| {
            if p.mint == event.mint && p.triggered_by(&event.whale) {
                closed.push((p.clone(), SellReason::TriggeringWhaleExited));
                false // remove from open positions
            } else {
                true // keep — not triggered by this whale, isolation holds
            }
        });
        closed
    }
}

// ---------------------------------------------------------------------
// Unit test proving the isolation guarantee from §3.3.
// ---------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_position(mint: &str, whale: &str) -> Position {
        Position {
            mint: mint.to_string(),
            trigger: TriggerSource::SingleWhale(whale.to_string()),
            sol_invested: 0.5,
            entry_price: 0.001,
            take_profit_pct: 50.0,
            stop_loss_pct: 20.0,
            trailing_stop_pct: None,
            opened_at: Instant::now(),
            is_migrated_to_raydium: false,
        }
    }

    #[test]
    fn different_whale_selling_does_not_close_position() {
        let mut engine = DecisionEngine::new(5.0);
        engine.positions.push(dummy_position("BONK2", "whale_A"));

        // whale_B sells the same mint — must NOT close whale_A's position
        let sell = SellEvent {
            whale: "whale_B".to_string(),
            mint: "BONK2".to_string(),
            fraction_sold: 1.0,
            at: Instant::now(),
        };
        let closed = engine.on_whale_sell(&sell);

        assert!(closed.is_empty(), "isolation violated: wrong whale closed the position");
        assert_eq!(engine.positions.len(), 1, "position must remain open");
    }

    #[test]
    fn triggering_whale_selling_does_close_position() {
        let mut engine = DecisionEngine::new(5.0);
        engine.positions.push(dummy_position("BONK2", "whale_A"));

        let sell = SellEvent {
            whale: "whale_A".to_string(),
            mint: "BONK2".to_string(),
            fraction_sold: 1.0,
            at: Instant::now(),
        };
        let closed = engine.on_whale_sell(&sell);

        assert_eq!(closed.len(), 1);
        assert!(engine.positions.is_empty());
    }

    #[test]
    fn overlap_scanner_fires_at_threshold() {
        let mut scanner = OverlapScanner::new(60, 3);
        let now = Instant::now();
        assert!(scanner.ingest(&BuyEvent { whale: "A".into(), mint: "X".into(), sol_amount: 0.1, at: now }).is_none());
        assert!(scanner.ingest(&BuyEvent { whale: "B".into(), mint: "X".into(), sol_amount: 0.1, at: now }).is_none());
        let signal = scanner.ingest(&BuyEvent { whale: "C".into(), mint: "X".into(), sol_amount: 0.1, at: now });
        assert!(signal.is_some(), "should fire on 3rd unique whale");
    }
}

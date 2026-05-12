import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy } from './settings.js';

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export function openPositionCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

export function realizedPnlSolInWindow(windowMs, { mode = null } = {}) {
  const cutoff = now() - Math.max(0, Number(windowMs) || 0);
  const params = [cutoff];
  let modeClause = '';
  if (mode) {
    modeClause = ' AND COALESCE(execution_mode, ?) = ?';
    params.push(mode, mode);
  }
  const row = db.prepare(`
    SELECT COALESCE(SUM(pnl_sol), 0) AS pnl
    FROM dry_run_positions
    WHERE status = 'closed' AND closed_at_ms >= ?${modeClause}
  `).get(...params);
  return Number(row?.pnl || 0);
}

export function consecutiveLossCount({ limit = 50 } = {}) {
  const rows = db.prepare(`
    SELECT pnl_sol FROM dry_run_positions
    WHERE status = 'closed'
    ORDER BY closed_at_ms DESC
    LIMIT ?
  `).all(Number(limit) || 50);
  let count = 0;
  for (const row of rows) {
    if (Number(row.pnl_sol || 0) < 0) count += 1;
    else break;
  }
  return count;
}

export function riskGuardStatus() {
  const lossBudget = numSetting('loss_budget_sol', 0);
  const windowMs = numSetting('loss_budget_window_ms', 24 * 60 * 60 * 1000);
  const maxConsec = numSetting('max_consecutive_losses', 0);
  const realized = lossBudget > 0 ? realizedPnlSolInWindow(windowMs) : 0;
  const consec = maxConsec > 0 ? consecutiveLossCount() : 0;
  const lossBudgetTripped = lossBudget > 0 && (-realized) >= lossBudget;
  const consecutiveTripped = maxConsec > 0 && consec >= maxConsec;
  return {
    blocked: lossBudgetTripped || consecutiveTripped,
    lossBudgetTripped,
    consecutiveTripped,
    lossBudget,
    realizedSolInWindow: realized,
    windowMs,
    maxConsecutiveLosses: maxConsec,
    consecutiveLosses: consec,
  };
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      strat.id,
      json({ candidate, decision, reason, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return positionId;
  })();
}

export function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
        execution_mode, entry_signature, token_amount_raw, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'live', ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      swap.signature,
      swap.outputAmount || null,
      strat.id,
      json({ candidate, decision, reason, swap, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision, swap }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return positionId;
  })();
}

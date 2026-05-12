import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';
import { STRATEGY_DEFAULTS } from './strategyDefaults.js';

export const db = new Database(DB_PATH);

export function initDb() {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saved_wallets (
      label TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      signature TEXT,
      signal_key TEXT,
      candidate_json TEXT NOT NULL,
      filter_result_json TEXT NOT NULL,
      UNIQUE(signature, mint)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at_ms INTEGER NOT NULL,
      telegram_message_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      symbol TEXT,
      status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      size_sol REAL NOT NULL,
      entry_price REAL,
      entry_mcap REAL,
      token_amount_est REAL,
      high_water_price REAL,
      high_water_mcap REAL,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      trailing_armed INTEGER NOT NULL DEFAULT 0,
      exit_price REAL,
      exit_mcap REAL,
      exit_reason TEXT,
      pnl_percent REAL,
      pnl_sol REAL,
      llm_decision_id INTEGER,
      execution_mode TEXT DEFAULT 'dry_run',
      entry_signature TEXT,
      exit_signature TEXT,
      token_amount_raw TEXT,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      side TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      price REAL,
      mcap REAL,
      size_sol REAL,
      token_amount_est REAL,
      reason TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tp_sl_rules (
      position_id INTEGER PRIMARY KEY,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trade_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      side TEXT NOT NULL,
      size_sol REAL NOT NULL,
      confidence REAL,
      reason TEXT,
      llm_decision_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decision_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      batch_id INTEGER,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      verdict TEXT,
      confidence REAL,
      reason TEXT,
      guardrails_json TEXT NOT NULL,
      token_json TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      batch_json TEXT NOT NULL,
      execution_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      window_ms INTEGER NOT NULL,
      summary_json TEXT NOT NULL,
      lessons_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      lesson TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      target_price_usd REAL,
      target_mcap_usd REAL,
      target_ath_distance_percent REAL,
      candidate_json TEXT NOT NULL,
      signals_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at_ms INTEGER NOT NULL,
      triggered_at_ms INTEGER,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON price_alerts(status, expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_candidates_mint ON candidates(mint);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON dry_run_positions(status);
    CREATE INDEX IF NOT EXISTS idx_trade_intents_status ON trade_intents(status);
    CREATE INDEX IF NOT EXISTS idx_decision_logs_mint ON decision_logs(selected_mint);
    CREATE INDEX IF NOT EXISTS idx_signal_events_mint ON signal_events(mint);
    CREATE INDEX IF NOT EXISTS idx_learning_lessons_status ON learning_lessons(status, created_at_ms);
  `);
  ensureColumn('candidates', 'signal_key', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_signal_key ON candidates(signal_key) WHERE signal_key IS NOT NULL');
  ensureColumn('dry_run_positions', 'execution_mode', "TEXT DEFAULT 'dry_run'");
  ensureColumn('dry_run_positions', 'entry_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'exit_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'token_amount_raw', 'TEXT');
  ensureColumn('dry_run_positions', 'strategy_id', "TEXT DEFAULT 'sniper'");
  ensureColumn('dry_run_positions', 'partial_tp_done', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'partial_realized_sol', 'REAL DEFAULT 0');
  ensureColumn('dry_run_positions', 'partial_sold_fraction', 'REAL DEFAULT 0');
  ensureColumn('decision_logs', 'strategy_id', 'TEXT');

  const defaults = {
    agent_enabled: 'true',
    trading_mode: process.env.TRADING_MODE || 'dry_run',
    llm_candidate_pick_count: process.env.LLM_CANDIDATE_PICK_COUNT || '10',
    llm_candidate_max_age_ms: process.env.LLM_CANDIDATE_MAX_AGE_MS || String(10 * 60 * 1000),
    llm_min_confidence: '75',
    max_open_positions: process.env.MAX_OPEN_POSITIONS || '3',
    dry_run_buy_sol: '0.1',
    default_tp_percent: '50',
    default_sl_percent: '-25',
    default_trailing_enabled: 'true',
    default_trailing_percent: '20',
    min_fee_claim_sol: process.env.MIN_FEE_CLAIM_SOL || '2',
    min_mcap_usd: '0',
    max_mcap_usd: '0',
    min_gmgn_total_fee_sol: '0',
    min_graduated_volume_usd: '0',
    max_top20_holder_percent: '100',
    min_saved_wallet_holders: '0',
    gmgn_request_delay_ms: process.env.GMGN_REQUEST_DELAY_MS || '2500',
    gmgn_max_retries: process.env.GMGN_MAX_RETRIES || '2',
    trending_enabled: process.env.TRENDING_ENABLED || 'true',
    trending_source: process.env.TRENDING_SOURCE || 'jupiter',
    trending_allow_degen: process.env.TRENDING_ALLOW_DEGEN || 'false',
    trending_interval: process.env.TRENDING_INTERVAL || '5m',
    trending_limit: process.env.TRENDING_LIMIT || '100',
    trending_order_by: process.env.TRENDING_ORDER_BY || 'volume',
    trending_min_volume_usd: process.env.TRENDING_MIN_VOLUME_USD || '0',
    trending_min_swaps: process.env.TRENDING_MIN_SWAPS || '0',
    trending_max_rug_ratio: process.env.TRENDING_MAX_RUG_RATIO || '0.3',
    trending_max_bundler_rate: process.env.TRENDING_MAX_BUNDLER_RATE || '0.5',
    // Risk-control kill switches. 0 disables. Defaults are conservative-ish.
    loss_budget_sol: process.env.LOSS_BUDGET_SOL || '0',
    loss_budget_window_ms: process.env.LOSS_BUDGET_WINDOW_MS || String(24 * 60 * 60 * 1000),
    max_consecutive_losses: process.env.MAX_CONSECUTIVE_LOSSES || '0',
    // When set, position monitor exits on a sharp mcap drop from the high
    // water mark even if trailing has not armed yet. Strategies can override.
    rug_drop_percent: process.env.RUG_DROP_PERCENT || '0',
    rug_min_hold_ms: process.env.RUG_MIN_HOLD_MS || '60000',
  };
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaults)) insert.run(key, value);

  // Seed default strategies from the shared STRATEGY_DEFAULTS map so that
  // settings.js and this seed cannot drift.
  const stratInsert = db.prepare('INSERT OR IGNORE INTO strategies (id, name, enabled, config_json, created_at_ms) VALUES (?, ?, ?, ?, ?)');
  const ts = Date.now();
  const strategyNames = { sniper: 'Sniper', dip_buy: 'Dip Buy', smart_money: 'Smart Money', degen: 'Degen' };
  const strategyEnabled = { sniper: 1, dip_buy: 0, smart_money: 0, degen: 0 };
  for (const [id, config] of Object.entries(STRATEGY_DEFAULTS)) {
    stratInsert.run(id, strategyNames[id] || id, strategyEnabled[id] || 0, JSON.stringify(config), ts);
  }
}

export function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

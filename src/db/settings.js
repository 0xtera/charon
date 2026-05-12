import { db } from './connection.js';
import { STRATEGY_DEFAULTS, strategyConfigWithDefaults } from './strategyDefaults.js';

export function setting(key, fallback = '') {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

export function boolSetting(key, fallback = false) {
  const value = setting(key, fallback ? 'true' : 'false');
  return value === 'true' || value === '1' || value === 'yes';
}

export function numSetting(key, fallback = 0) {
  const value = Number(setting(key, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

const strategyCache = { id: null, config: null, at: 0 };

function parseStrategyRow(row) {
  if (!row) return null;
  let stored = {};
  try {
    stored = JSON.parse(row.config_json) || {};
  } catch {
    stored = {};
  }
  return { id: row.id, name: row.name, ...strategyConfigWithDefaults(row.id, stored) };
}

export function activeStrategy() {
  if (strategyCache.config && Date.now() - strategyCache.at < 5000) return strategyCache.config;
  const row = db.prepare('SELECT * FROM strategies WHERE enabled = 1 LIMIT 1').get();
  if (!row) {
    const fallback = strategyById('sniper');
    if (fallback) return fallback;
    return defaultStrategy();
  }
  const config = parseStrategyRow(row);
  strategyCache.id = row.id;
  strategyCache.config = config;
  strategyCache.at = Date.now();
  return config;
}

export function strategyById(id) {
  const row = db.prepare('SELECT * FROM strategies WHERE id = ?').get(id);
  return parseStrategyRow(row);
}

export function allStrategies() {
  return db.prepare('SELECT * FROM strategies ORDER BY id').all().map(row => ({
    ...parseStrategyRow(row),
    enabled: Boolean(row.enabled),
  }));
}

export function setActiveStrategy(id) {
  db.prepare('UPDATE strategies SET enabled = 0').run();
  db.prepare('UPDATE strategies SET enabled = 1 WHERE id = ?').run(id);
  strategyCache.config = null;
  strategyCache.at = 0;
}

export function updateStrategyConfig(id, config) {
  db.prepare('UPDATE strategies SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
  if (strategyCache.id === id) {
    strategyCache.config = null;
    strategyCache.at = 0;
  }
}

export function strategySetting(key, fallback) {
  const strat = activeStrategy();
  if (strat[key] !== undefined && strat[key] !== null) return strat[key];
  return numSetting(key, fallback);
}

function defaultStrategy() {
  return { id: 'sniper', name: 'Sniper', ...STRATEGY_DEFAULTS.sniper };
}


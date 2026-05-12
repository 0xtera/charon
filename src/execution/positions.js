import { now, json } from '../utils.js';
import { numSetting, boolSetting, strategyById } from '../db/settings.js';
import { db } from '../db/connection.js';
import { firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn } from '../utils.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, fetchJupiterWalletPnl } from '../enrichment/jupiter.js';
import { liveWalletPubkey } from '../liveExecutor.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { openPositions } from '../db/positions.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { trending } from '../signals/trending.js';
import { executeLiveSell } from './router.js';
import { sendPositionExit } from '../telegram/send.js';

export async function freshEntryMarket(mint, candidate) {
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  return { gmgn, asset, priceUsd, marketCapUsd, refreshedAtMs: now() };
}

export async function refreshCandidateForExecution(row) {
  const candidate = row.candidate;
  const mint = candidate.token.mint;
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const selectedTrending = trending.get(mint) || candidate.trending || null;
  const selectedHolders = holders?.holders?.length ? holders : candidate.holders;
  const selectedSavedWalletExposure = selectedHolders
    ? await fetchSavedWalletExposure(mint, selectedHolders)
    : candidate.savedWalletExposure;
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, selectedTrending?.price, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    selectedTrending?.market_cap,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  const refreshed = {
    ...candidate,
    token: {
      ...candidate.token,
      name: gmgn?.name || asset?.name || selectedTrending?.name || candidate.token.name,
      symbol: gmgn?.symbol || asset?.symbol || selectedTrending?.symbol || candidate.token.symbol,
      twitter: candidate.token.twitter || asset?.twitter || gmgn?.link?.twitter_username || selectedTrending?.twitter || '',
      website: candidate.token.website || asset?.website || gmgn?.link?.website || '',
      telegram: candidate.token.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      ...candidate.metrics,
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? candidate.metrics?.liquidityUsd ?? 0),
      holderCount: Number(gmgn?.holder_count ?? asset?.holderCount ?? selectedTrending?.holder_count ?? candidate.metrics?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? asset?.fees ?? candidate.metrics?.gmgnTotalFeesSol ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? candidate.metrics?.gmgnTradeFeesSol ?? 0),
      trendingVolumeUsd: Number(selectedTrending?.volume ?? candidate.metrics?.trendingVolumeUsd ?? 0),
      trendingSwaps: Number(selectedTrending?.swaps ?? candidate.metrics?.trendingSwaps ?? 0),
      trendingHotLevel: Number(selectedTrending?.hot_level ?? candidate.metrics?.trendingHotLevel ?? 0),
      trendingSmartDegenCount: Number(selectedTrending?.smart_degen_count ?? candidate.metrics?.trendingSmartDegenCount ?? 0),
    },
    gmgn,
    jupiterAsset: asset,
    trending: selectedTrending,
    holders: selectedHolders,
    chart,
    savedWalletExposure: selectedSavedWalletExposure,
    executionRefresh: {
      refreshedAtMs: now(),
      source: 'pre_execution',
      marketCapUsd,
      priceUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? 0),
      holdersRefreshed: Boolean(holders?.holders?.length),
    },
  };
  refreshed.filters = filterCandidate(refreshed);
  const executionFailures = [];
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    executionFailures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    executionFailures.push('execution price: missing');
  }
  if (executionFailures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...executionFailures],
    };
  }
  updateCandidateSnapshot(row.id, refreshed, refreshed.filters.passed ? 'candidate' : 'filtered');
  return { ...row, candidate: refreshed };
}

const sellInProgress = new Set();

export async function refreshPosition(position, { autoExit = true, jupiterPnl = null } = {}) {
  const asset = await fetchJupiterAsset(position.mint);
  // Only accept fresh market data from the live source. Falling back to
  // high_water_mcap masks drawdowns and prevents SL/RUG/TRAILING from
  // firing when the Jupiter asset endpoint is rate-limited or temporarily
  // down. If we have no fresh mcap, skip this tick and revisit on the next
  // monitor cycle.
  const freshPrice = firstPositiveNumber(asset?.usdPrice);
  const freshMcap = firstPositiveNumber(asset?.mcap, asset?.fdv);
  if (!Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) return null;
  if (!Number.isFinite(Number(freshMcap))) {
    return { ...position, asset, price: position.high_water_price, mcap: position.high_water_mcap, skipped: 'stale_mcap' };
  }
  const price = firstPositiveNumber(freshPrice, position.high_water_price, position.entry_price);
  const mcap = Number(freshMcap);
  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), mcap);
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  // Mutable local mirror of the row so that a partial TP firing in the same
  // tick as a full exit propagates the updated token_amount_raw and
  // partial-realized totals to the live sell call and final PnL math.
  let currentPosition = position;
  let partialRealizedSol = Number(position.partial_realized_sol || 0);
  let partialSoldFraction = Math.max(0, Math.min(1, Number(position.partial_sold_fraction || 0)));
  const remainingSizeSol = Number(position.size_sol) * (1 - partialSoldFraction);
  let pnlPercent = (mcap / Number(position.entry_mcap) - 1) * 100;
  let unrealizedPnlSol = remainingSizeSol * pnlPercent / 100;
  let pnlSol = partialRealizedSol + unrealizedPnlSol;
  if (jupiterPnl && Number.isFinite(Number(jupiterPnl.totalPnlPercentageNative))) {
    // Jupiter wallet PnL already represents realized + unrealized for the
    // mint at the wallet level. Trust it directly when available.
    pnlPercent = Number(jupiterPnl.totalPnlPercentageNative);
    pnlSol = Number.isFinite(Number(jupiterPnl.totalPnlNative)) ? Number(jupiterPnl.totalPnlNative) : pnlSol;
  }
  const tpHit = pnlPercent >= Number(position.tp_percent);
  const slHit = pnlPercent <= Number(position.sl_percent);
  const trailingArmed = position.trailing_armed || (position.trailing_enabled && tpHit);
  const trailDropFromHigh = highWaterMcap > 0 ? (mcap / highWaterMcap - 1) * 100 : 0;
  const trailingHit = trailingArmed && position.trailing_enabled && trailDropFromHigh <= -Math.abs(Number(position.trailing_percent));
  let exitReason = null;
  let closed = false;

  const strat = strategyById(position.strategy_id);

  // Max hold time check
  if (strat?.max_hold_ms > 0 && (now() - position.opened_at_ms) >= strat.max_hold_ms) {
    exitReason = 'MAX_HOLD';
  }

  // Rug detection: a sharp drop from the high-water mark triggers an
  // unconditional exit even if trailing has not armed yet. This protects
  // against memecoin rugs that drop 60-90% in a single block when SL alone
  // would still fire too late to escape.
  const rugDropPct = Number(strat?.rug_drop_percent ?? 0);
  const rugMinHold = Number(strat?.rug_min_hold_ms ?? 60_000);
  const heldMs = now() - Number(position.opened_at_ms || now());
  if (!exitReason && rugDropPct > 0 && heldMs >= rugMinHold && trailDropFromHigh <= -Math.abs(rugDropPct)) {
    exitReason = 'RUG';
  }

  // Partial TP check (works in both dry_run and live modes)
  if (!exitReason && strat?.partial_tp && !currentPosition.partial_tp_done && pnlPercent >= Number(strat.partial_tp_at_percent || 0)) {
    const sellFraction = Math.max(0, Math.min(1, Number(strat.partial_tp_sell_percent || 0) / 100));
    if (sellFraction > 0) {
      const partialCostSol = remainingSizeSol * sellFraction;
      let realizedThisSol = partialCostSol * (1 + pnlPercent / 100);
      let partialOk = true;
      let sellRaw = null;
      let remainingTokenRaw = currentPosition.token_amount_raw;
      if (currentPosition.execution_mode === 'live' && currentPosition.token_amount_raw) {
        try {
          const sellAmount = Math.floor(Number(currentPosition.token_amount_raw) * sellFraction);
          if (sellAmount > 0) {
            const sell = await executeLiveSell({ ...currentPosition, token_amount_raw: String(sellAmount) }, 'PARTIAL_TP');
            const receivedLamports = Number(sell.outputAmount || 0);
            if (receivedLamports > 0) realizedThisSol = receivedLamports / 1_000_000_000;
            sellRaw = sell;
            remainingTokenRaw = String(Number(currentPosition.token_amount_raw) - sellAmount);
            db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(remainingTokenRaw, currentPosition.id);
          } else {
            partialOk = false;
          }
        } catch (err) {
          console.log(`[position] ${currentPosition.id} partial sell failed: ${err.message}`);
          partialOk = false;
        }
      }
      if (partialOk) {
        const realizedGain = realizedThisSol - partialCostSol;
        const newRealized = partialRealizedSol + realizedGain;
        const newSoldFraction = Math.min(1, partialSoldFraction + (1 - partialSoldFraction) * sellFraction);
        db.prepare(`
          UPDATE dry_run_positions
          SET partial_tp_done = 1, partial_realized_sol = ?, partial_sold_fraction = ?
          WHERE id = ?
        `).run(newRealized, newSoldFraction, currentPosition.id);
        db.prepare(`
          INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
          VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
        `).run(currentPosition.id, currentPosition.mint, now(), price, mcap, partialCostSol, null,
          json({ pnlPercent, realizedSol: realizedThisSol, partialCostSol, sellFraction, partialRealizedSol: newRealized, sell: sellRaw }));
        console.log(`[position] ${currentPosition.id} partial TP ${(sellFraction * 100).toFixed(0)}% at ${pnlPercent.toFixed(1)}% (realized ${realizedThisSol.toFixed(4)} SOL of ${partialCostSol.toFixed(4)} cost)`);
        // Propagate the partial state locally so a same-tick full exit sells
        // only the remaining tokens and computes PnL on the reduced cost basis.
        partialRealizedSol = newRealized;
        partialSoldFraction = newSoldFraction;
        currentPosition = {
          ...currentPosition,
          token_amount_raw: remainingTokenRaw,
          partial_tp_done: 1,
          partial_realized_sol: newRealized,
          partial_sold_fraction: newSoldFraction,
        };
        const newRemaining = Number(currentPosition.size_sol) * (1 - newSoldFraction);
        unrealizedPnlSol = newRemaining * pnlPercent / 100;
        pnlSol = newRealized + unrealizedPnlSol;
      }
    }
  }

  // Standard exit checks
  if (!exitReason) {
    if (slHit) exitReason = 'SL';
    else if (tpHit && !position.trailing_enabled) exitReason = 'TP';
    else if (trailingHit) exitReason = 'TRAILING_TP';
  }

  // Live exits will override these with realized SOL values
  let finalPnlPercent = pnlPercent;
  let finalPnlSol = pnlSol;

  db.prepare(`
    UPDATE dry_run_positions
    SET high_water_mcap = ?, high_water_price = ?, trailing_armed = ?
    WHERE id = ?
  `).run(highWaterMcap, highWaterPrice, trailingArmed ? 1 : 0, currentPosition.id);

  if (exitReason && autoExit && currentPosition.execution_mode === 'live') {
    if (sellInProgress.has(currentPosition.id)) return { ...currentPosition, exitReason: null };
    sellInProgress.add(currentPosition.id);
    let sell;
    try {
      sell = await executeLiveSell(currentPosition, exitReason);
    } finally {
      sellInProgress.delete(currentPosition.id);
    }
    const receivedLamports = Number(sell.outputAmount || 0);
    const receivedSol = receivedLamports > 0 ? receivedLamports / 1_000_000_000 : null;
    const remainingCostSol = Number(currentPosition.size_sol) * (1 - partialSoldFraction);
    if (receivedSol != null) {
      finalPnlSol = partialRealizedSol + (receivedSol - remainingCostSol);
      finalPnlPercent = Number(currentPosition.size_sol) > 0 ? (finalPnlSol / Number(currentPosition.size_sol)) * 100 : finalPnlPercent;
    }
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, sell.signature, currentPosition.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(currentPosition.id, currentPosition.mint, now(), price, mcap, remainingCostSol, currentPosition.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, receivedSol: receivedSol ?? null, partialRealizedSol, sell }));
    closed = true;
  } else if (exitReason && autoExit) {
    const remainingCostSol = Number(currentPosition.size_sol) * (1 - partialSoldFraction);
    finalPnlSol = partialRealizedSol + (remainingCostSol * pnlPercent / 100);
    finalPnlPercent = Number(currentPosition.size_sol) > 0 ? (finalPnlSol / Number(currentPosition.size_sol)) * 100 : pnlPercent;
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?, pnl_percent = ?, pnl_sol = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, currentPosition.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(currentPosition.id, currentPosition.mint, now(), price, mcap, remainingCostSol, currentPosition.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, partialRealizedSol }));
    closed = true;
  }
  return {
    ...currentPosition,
    status: closed ? 'closed' : currentPosition.status,
    closed_at_ms: closed ? now() : currentPosition.closed_at_ms,
    asset,
    price,
    mcap,
    highWaterMcap,
    high_water_mcap: highWaterMcap,
    high_water_price: highWaterPrice,
    pnlPercent: finalPnlPercent,
    pnl_percent: finalPnlPercent,
    pnlSol: finalPnlSol,
    pnl_sol: finalPnlSol,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : currentPosition.exit_reason,
    exit_mcap: closed ? mcap : currentPosition.exit_mcap,
    exit_price: closed ? price : currentPosition.exit_price,
  };
}

export async function monitorPositions() {
  const positions = openPositions();
  let walletPnlData = {};
  const pubkey = liveWalletPubkey();
  if (pubkey && positions.some(p => p.execution_mode === 'live')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey);
  }
  for (const position of positions) {
    const jupiterPnl = position.execution_mode === 'live'
      ? (walletPnlData[position.mint]?.pnl || null)
      : null;
    const result = await refreshPosition(position, { autoExit: true, jupiterPnl }).catch((err) => {
      console.log(`[position] ${position.id} ${err.message}`);
      return null;
    });
    if (result?.exitReason) await sendPositionExit(result);
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.join(process.cwd(), 'autonomous-ai');
const mode = process.argv[2] || 'post';
const outputPath = process.env.GITHUB_OUTPUT || '';

async function readJson(name, fallback = {}) {
  try { return JSON.parse(await fs.readFile(path.join(root, name), 'utf8')); }
  catch { return fallback; }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function same(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function currentEconomy(economy = {}) {
  return {
    walletConfigured: Boolean(economy.wallets?.tonAddress || economy.wallets?.tronAddress),
    balances: economy.balances || {},
    totals: economy.totals || {},
    recentLedgerIds: (economy.ledger || []).slice(-5).map((x) => x.id),
  };
}

function previousEconomy(state = {}) {
  const economy = state.economy || {};
  return {
    walletConfigured: Boolean(economy.walletConfigured),
    balances: economy.balances || {},
    totals: economy.totals || {},
    recentLedgerIds: (economy.recentLedger || []).slice(-5).map((x) => x.id).filter(Boolean),
  };
}

function currentJobs(jobs = {}) {
  return {
    selectedId: jobs.selected?.id || null,
    selectionStatus: jobs.selection?.status || null,
    active: jobs.active ? {
      id: jobs.active.id || null,
      stage: jobs.active.stage || jobs.active.status || null,
      error: jobs.active.error || null,
      preparedAt: jobs.active.preparedAt || null,
    } : null,
    completedCount: (jobs.completed || []).length,
  };
}

function previousJobs(state = {}) {
  const jobs = state.jobs || {};
  return {
    selectedId: jobs.selected?.id || null,
    selectionStatus: jobs.selection?.status || null,
    active: jobs.active ? {
      id: jobs.active.id || null,
      stage: jobs.active.stage || jobs.active.status || null,
      error: jobs.active.error || null,
      preparedAt: jobs.active.preparedAt || null,
    } : null,
    completedCount: Number(jobs.completedCount || 0),
  };
}

async function emit(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value)}`).join('\n') + '\n';
  if (outputPath) await fs.appendFile(outputPath, lines);
  console.log(lines.trim());
}

const [state, economy, jobs] = await Promise.all([
  readJson('state.json', { cycle: 0 }),
  readJson('economy.json', {}),
  readJson('jobs.json', {}),
]);

const now = Date.now();
const retryAt = jobs.retryAfterAt ? Date.parse(jobs.retryAfterAt) : 0;
const providerWaiting = /waiting_provider|retry_wait/i.test(String(jobs.status || '')) && retryAt > now;
const select = Boolean(jobs.needsSelection) && !providerWaiting;
const revenue = Number(economy?.totals?.revenueUSDT || 0);
const bootstrapMode = revenue <= 0 && (jobs.completed || []).length === 0;

const economyChanged = !same(currentEconomy(economy), previousEconomy(state));
const jobsChanged = !same(currentJobs(jobs), previousJobs(state));
const ageMs = now - (Date.parse(state.updatedAt || 0) || 0);
const heartbeatMs = bootstrapMode ? 6 * 60 * 60 * 1000 : 60 * 60 * 1000;
const heartbeatDue = ageMs >= heartbeatMs;

if (mode === 'pre') {
  await emit({
    select: select ? 'true' : 'false',
    economy_changed: economyChanged ? 'true' : 'false',
    jobs_changed: jobsChanged ? 'true' : 'false',
    reason: select ? 'new_market_decision' : (economyChanged || jobsChanged ? 'state_changed' : 'no_material_change'),
  });
} else {
  const stillWaiting = Boolean(jobs.needsSelection) && /waiting_provider|retry_wait/i.test(String(jobs.status || ''));
  const think = Number(state.cycle || 0) === 0
    || economyChanged
    || (!stillWaiting && jobsChanged)
    || (!stillWaiting && heartbeatDue);

  await emit({
    think: think ? 'true' : 'false',
    mode: bootstrapMode ? 'bootstrap' : 'growth',
    reason: think
      ? (economyChanged ? 'economy_changed' : jobsChanged ? 'earning_state_changed' : heartbeatDue ? 'heartbeat' : 'initial_cycle')
      : (stillWaiting ? 'provider_cooldown' : 'no_earning_event'),
  });
}

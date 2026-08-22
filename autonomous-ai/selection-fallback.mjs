import fs from 'node:fs/promises';
import path from 'node:path';

const JOBS_PATH = path.join(process.cwd(), 'autonomous-ai/jobs.json');

function clean(v, max = 220) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function deterministicEV(x) {
  const reward = Math.max(0, Number(x.economicValueUsd ?? x.rewardUsd ?? 0));
  const payout = Math.max(0, Math.min(1, Number(x.payoutConfidence || 0)));
  const autonomy = Math.max(0, Math.min(1, Number(x.autonomyFit || 0)));
  const hours = Math.max(1, Number(x.estimatedHoursBand || 4));
  const attemptPenalty = 1 / (1 + Math.max(0, Number(x.competition?.attemptSignals || 0)) * 0.5);
  const commentPenalty = 1 / (1 + Math.max(0, Number(x.commentCount || 0)) / 20);
  const acceptanceProxy = payout * autonomy * attemptPenalty * commentPenalty;
  const expectedCash = reward * acceptanceProxy;
  const cashPerHour = expectedCash / hours;
  return { expectedCash, cashPerHour, acceptanceProxy };
}

const jobs = JSON.parse(await fs.readFile(JOBS_PATH, 'utf8'));
const survivalMode = Number(jobs.completed?.length || 0) === 0;
const candidates = (jobs.opportunities || []).filter((x) => {
  if (x.realMoneyEligible === false) return false;
  if (x.requiresPreclaimOrIdentity) return false;
  if (x.requiresHumanGate || x.requiresSpecialHardware) return false;
  if (Number(x.payoutConfidence || 0) < (survivalMode ? 0.8 : 0.55)) return false;
  if (Number(x.autonomyFit || 0) < (survivalMode ? 0.85 : 0.75)) return false;
  if (survivalMode && String(x.competition?.risk || '') !== 'low') return false;
  if (survivalMode && x.survivalEligible !== true) return false;
  if (survivalMode && Number(x.estimatedHoursBand || 99) > 4) return false;
  return true;
});

const ranked = candidates.map((x) => ({ x, ...deterministicEV(x) })).sort((a, b) => {
  if (b.cashPerHour !== a.cashPerHour) return b.cashPerHour - a.cashPerHour;
  if (b.expectedCash !== a.expectedCash) return b.expectedCash - a.expectedCash;
  return Number(b.x.fastCashScore || 0) - Number(a.x.fastCashScore || 0);
});

const best = ranked[0] || null;
const approved = best && best.acceptanceProxy >= 0.5 && best.cashPerHour >= 2 ? best : null;

if (approved) {
  jobs.selected = { ...approved.x, state: 'selected' };
  jobs.selection = {
    status: 'selected_bootstrap_deterministic',
    mode: survivalMode ? 'bootstrap' : 'growth',
    confidence: Number(approved.acceptanceProxy.toFixed(2)),
    rationale: clean('Selected the highest expected real cash/hour among simple, low-competition, executable jobs.'),
    expectedHours: Number(approved.x.estimatedHoursBand || 4),
    timeToCashHours: Number(approved.x.estimatedHoursBand || 4),
    expectedCostUsd: 0,
    estimatedProfitUsd: Number(approved.expectedCash.toFixed(2)),
    expectedCashPerHourUsd: Number(approved.cashPerHour.toFixed(2)),
    payoutConfidence: Number(approved.x.payoutConfidence || 0),
    autonomyFit: Number(approved.x.autonomyFit || 0),
    provider: { mode: 'deterministic', model: null, attempts: 0 },
  };
  jobs.status = 'selected';
} else {
  jobs.selected = null;
  jobs.active = null;
  jobs.selection = {
    status: 'none_bootstrap',
    mode: survivalMode ? 'bootstrap' : 'growth',
    rationale: candidates.length
      ? 'No candidate clears the minimum expected real cash/hour and acceptance thresholds.'
      : 'No simple real-money job is currently executable with the basic identity and tooling available.',
  };
  jobs.status = 'idle';
}

jobs.lastError = null;
jobs.retryAfterAt = null;
jobs.needsSelection = false;
jobs.marketChanged = false;
jobs.updatedAt = new Date().toISOString();
await fs.writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
console.log(`Bootstrap selection: status=${jobs.status}; selected=${jobs.selected?.title || 'none'}`);

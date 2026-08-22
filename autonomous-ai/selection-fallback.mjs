import fs from 'node:fs/promises';
import path from 'node:path';

const JOBS_PATH = path.join(process.cwd(), 'autonomous-ai/jobs.json');

function clean(v, max = 220) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function riskWeight(risk) {
  if (risk === 'low') return 1;
  if (risk === 'medium') return 0.7;
  if (risk === 'high') return 0.2;
  if (risk === 'saturated') return 0;
  return 0.4;
}

function deterministicEV(x) {
  const reward = Math.max(0, Number(x.economicValueUsd ?? x.rewardUsd ?? 0));
  const payout = Math.max(0, Math.min(1, Number(x.payoutConfidence || 0)));
  const autonomy = Math.max(0, Math.min(1, Number(x.autonomyFit || 0)));
  const hours = Math.max(1, Number(x.estimatedHoursBand || 8));
  const competition = riskWeight(String(x.competition?.risk || 'unknown'));
  const attemptPenalty = 1 / (1 + Math.max(0, Number(x.competition?.attemptSignals || 0)) * 0.35);
  const commentPenalty = 1 / (1 + Math.max(0, Number(x.commentCount || 0)) / 25);
  const acceptanceProxy = payout * autonomy * competition * attemptPenalty * commentPenalty;
  const expectedCash = reward * acceptanceProxy;
  const cashPerHour = expectedCash / hours;
  return { expectedCash, cashPerHour, acceptanceProxy };
}

const jobs = JSON.parse(await fs.readFile(JOBS_PATH, 'utf8'));
const survivalMode = Number(jobs.completed?.length || 0) === 0;
const candidates = (jobs.opportunities || []).filter((x) => {
  if (x.realMoneyEligible === false) return false;
  if (x.requiresHumanGate || x.requiresSpecialHardware) return false;
  if (Number(x.payoutConfidence || 0) < 0.55) return false;
  if (Number(x.autonomyFit || 0) < 0.75) return false;
  if (String(x.competition?.risk || '') === 'saturated') return false;
  if (survivalMode && x.survivalEligible !== true) return false;
  if (survivalMode && Number(x.estimatedHoursBand || 99) > 8) return false;
  return true;
});

const currentValid = jobs.selected && candidates.some((x) => x.id === jobs.selected.id);
const selectorFailed = /degraded|waiting_provider|retry_wait/i.test(String(jobs.status || '')) || Boolean(jobs.lastError);
const selectionMissing = !jobs.selected && candidates.length > 0;

if (!currentValid && (selectorFailed || selectionMissing)) {
  const ranked = candidates.map((x) => ({ x, ...deterministicEV(x) })).sort((a, b) => {
    if (b.cashPerHour !== a.cashPerHour) return b.cashPerHour - a.cashPerHour;
    if (b.expectedCash !== a.expectedCash) return b.expectedCash - a.expectedCash;
    return Number(b.x.fastCashScore || 0) - Number(a.x.fastCashScore || 0);
  });

  const best = ranked[0] || null;
  // Survival threshold: don't burn inference/work on candidates with tiny estimated chance/value.
  const approved = best && best.acceptanceProxy >= 0.35 && best.cashPerHour >= 1 ? best : null;

  if (approved) {
    jobs.selected = { ...approved.x, state: 'selected' };
    jobs.selection = {
      status: 'selected_deterministic_fallback',
      mode: survivalMode ? 'survival' : 'growth',
      confidence: Number(approved.acceptanceProxy.toFixed(2)),
      rationale: clean(`Deterministic fallback selected highest expected real cash/hour after payout, competition, autonomy and time checks.`),
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
    jobs.lastError = null;
    jobs.retryAfterAt = null;
    jobs.needsSelection = false;
    jobs.marketChanged = false;
  } else {
    jobs.selected = null;
    jobs.selection = {
      status: 'none_deterministic',
      mode: survivalMode ? 'survival' : 'growth',
      rationale: candidates.length
        ? 'No candidate clears minimum expected real cash and acceptance thresholds.'
        : 'No real-money autonomous candidate passes survival filters.',
    };
    jobs.status = 'idle';
    jobs.lastError = null;
    jobs.retryAfterAt = null;
    jobs.needsSelection = false;
    jobs.marketChanged = false;
  }
}

jobs.updatedAt = new Date().toISOString();
await fs.writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
console.log(`Selection fallback: status=${jobs.status}; selected=${jobs.selected?.title || 'none'}`);

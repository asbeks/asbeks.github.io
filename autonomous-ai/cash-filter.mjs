import fs from 'node:fs/promises';
import path from 'node:path';

const JOBS_PATH = path.join(process.cwd(), 'autonomous-ai/jobs.json');

function labelsOf(x) {
  return (x.labels || []).map((v) => String(v).toLowerCase());
}

function textOf(x) {
  return `${x.title || ''} ${x.summary || ''} ${(x.labels || []).join(' ')}`.toLowerCase();
}

function isTestMoney(x) {
  const s = textOf(x);
  return /\btestnet\b|\btest tokens?\b|\btest usdc\b|\bfaucet tokens?\b|\bdevnet\b|\bsepolia\b|\bgoerli\b|\barc[- ]testnet\b/.test(s);
}

function isAlreadyRewarded(x) {
  const labels = labelsOf(x);
  return labels.some((l) => /(^|\s)rewarded$/.test(l.replace(/[^a-z\s]/g, '').trim()))
    || labels.some((l) => l.includes('💰 rewarded'))
    || labels.some((l) => /^(paid|completed bounty|bounty paid|claimed)$/.test(l.replace(/[^a-z ]/g, '').trim()));
}

function requiresPreclaimOrIdentity(x) {
  const s = textOf(x);
  return /\/attempt\b|\/try\b|comment .*before (?:you )?start|claim .*before|request assignment|must be assigned|assigned before|identity verification|\bkyc\b|sign up|signup|required account|join .*slack|fill out .*form|tax form|legal name/.test(s);
}

function difficultyFloor(x) {
  const s = textOf(x);
  let floor = Number(x.estimatedHoursBand || 4);
  if (/fully conformant|complete abnf|full .*coverage|every edge case|read .* completely|obsolete syntax|entire rfc|complete rfc/.test(s)) floor = Math.max(floor, 16);
  if (/parser/.test(s) && /rfc|grammar|abnf/.test(s)) floor = Math.max(floor, 12);
  if (/multi[- ]chain|event[- ]sourced|domain state|multiple .* aggregates|architecture redesign/.test(s)) floor = Math.max(floor, 12);
  if (/figma|pixel[- ]perfect|interaction-quality|visual parity/.test(s)) floor = Math.max(floor, 10);
  if (/multiple files|all callers|across .* files|end-to-end/.test(s)) floor = Math.max(floor, 8);
  return floor;
}

const jobs = JSON.parse(await fs.readFile(JOBS_PATH, 'utf8'));
const rejected = [];
const kept = [];

for (const original of jobs.opportunities || []) {
  const x = { ...original };
  const reasons = [];
  const testMoney = isTestMoney(x);
  const rewarded = isAlreadyRewarded(x);
  const preclaim = requiresPreclaimOrIdentity(x);
  const hours = difficultyFloor(x);

  x.estimatedHoursBand = hours;
  x.realMoneyEligible = !testMoney;
  x.economicValueUsd = testMoney ? 0 : Number(x.rewardUsd || 0);
  x.requiresPreclaimOrIdentity = preclaim;

  if (testMoney) reasons.push('testnet_or_test_token_reward');
  if (rewarded) reasons.push('already_rewarded_or_paid');
  if (preclaim) reasons.push('preclaim_or_identity_gate_not_configured');
  if (!Number.isFinite(Number(x.rewardUsd)) || Number(x.rewardUsd) <= 0) reasons.push('no_positive_reward');

  x.survivalEligible = Boolean(
    reasons.length === 0
    && x.realMoneyEligible
    && Number(x.payoutConfidence || 0) >= 0.8
    && Number(x.autonomyFit || 0) >= 0.85
    && !x.requiresHumanGate
    && !x.requiresSpecialHardware
    && hours <= 4
    && String(x.competition?.risk || 'unknown') === 'low'
  );

  if (hours > 4 && reasons.length === 0) {
    x.eligibilityReason = 'Too slow for bootstrap mode: first real cash currently requires a <=4 hour task.';
  } else if (String(x.competition?.risk || 'unknown') !== 'low' && reasons.length === 0) {
    x.eligibilityReason = 'Competition is too high for bootstrap mode.';
  } else if (Number(x.payoutConfidence || 0) < 0.8 && reasons.length === 0) {
    x.eligibilityReason = 'Payout evidence is below the bootstrap confidence threshold.';
  }

  if (reasons.length) {
    rejected.push({ id: x.id, title: x.title, rewardUsd: x.rewardUsd, reasons, rejectedAt: new Date().toISOString() });
    continue;
  }

  kept.push(x);
}

kept.sort((a, b) => {
  const aEligible = a.survivalEligible ? 1 : 0;
  const bEligible = b.survivalEligible ? 1 : 0;
  if (aEligible !== bEligible) return bEligible - aEligible;
  return Number(b.fastCashScore || 0) - Number(a.fastCashScore || 0);
});

const eligible = kept.filter((x) => x.survivalEligible);

jobs.version = Math.max(11, Number(jobs.version || 0));
jobs.opportunities = kept;
jobs.economicallyRejected = [
  ...rejected,
  ...(jobs.economicallyRejected || []).filter((old) => !rejected.some((r) => r.id === old.id)),
].slice(0, 80);
jobs.survival = {
  ...(jobs.survival || {}),
  mode: Number(jobs.completed?.length || 0) === 0,
  objective: 'first_real_confirmed_cash_fast',
  policy: 'bootstrap_basic_v1',
  eligibleCount: eligible.length,
  maxHours: 4,
  minPayoutConfidence: 0.8,
  competitionRequired: 'low',
  rejectedFakeRevenueCount: rejected.filter((x) => x.reasons.includes('testnet_or_test_token_reward')).length,
  rejectedAlreadyPaidCount: rejected.filter((x) => x.reasons.includes('already_rewarded_or_paid')).length,
  rejectedIdentityGateCount: rejected.filter((x) => x.reasons.includes('preclaim_or_identity_gate_not_configured')).length,
};

let validSelected = false;
if (jobs.selected) {
  const fresh = kept.find((x) => x.id === jobs.selected.id);
  validSelected = Boolean(fresh?.survivalEligible);
  if (validSelected) jobs.selected = { ...fresh, state: 'selected' };
}

if (!validSelected) {
  if (jobs.selected) jobs.active = null;
  jobs.selected = null;
  jobs.selection = null;
  jobs.status = eligible.length ? 'candidates' : 'idle';
  jobs.needsSelection = eligible.length > 0;
  jobs.marketChanged = true;
  jobs.lastError = null;
  jobs.retryAfterAt = null;
}

jobs.updatedAt = new Date().toISOString();
await fs.writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
console.log(`Bootstrap cash filter: kept=${kept.length}; eligible=${eligible.length}; rejected=${rejected.length}`);

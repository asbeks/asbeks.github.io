import fs from 'node:fs/promises';
import path from 'node:path';
import { callOpenCode, isProviderUnavailableError } from './provider.mjs';

const ROOT = path.join(process.cwd(), 'autonomous-ai');
const JOBS_PATH = path.join(ROOT, 'jobs.json');
const ECONOMY_PATH = path.join(ROOT, 'economy.json');

function clean(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseJson(content) {
  const cleaned = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function readJson(file, fallback = {}) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

const jobs = await readJson(JOBS_PATH, { opportunities: [], completed: [] });
const economy = await readJson(ECONOMY_PATH, {});
const revenue = Number(economy?.totals?.revenueUSDT || 0);
const firstRevenueMissing = revenue <= 0 && (jobs.completed || []).length === 0;
const allCandidates = (jobs.opportunities || []).slice(0, 12);
const candidates = firstRevenueMissing
  ? allCandidates.filter((x) => x.survivalEligible === true)
  : allCandidates.filter((x) => Number(x.payoutConfidence || 0) >= 0.5 && Number(x.autonomyFit || 0) >= 0.5 && !x.requiresHumanGate);

if (!candidates.length) {
  jobs.selected = null;
  jobs.selection = {
    status: 'none',
    mode: firstRevenueMissing ? 'survival' : 'growth',
    rationale: firstRevenueMissing
      ? 'No job currently passes fast-cash survival rules. Keep scouting instead of burning compute on slow or blocked work.'
      : 'No autonomous paid candidate currently meets minimum payout and autonomy requirements.',
  };
  jobs.status = 'idle';
  jobs.needsSelection = false;
  jobs.marketChanged = false;
  jobs.lastError = null;
  jobs.retryAfterAt = null;
  jobs.updatedAt = new Date().toISOString();
  await fs.writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
  console.log('Autonomous selector: no survival-eligible candidate');
  process.exit(0);
}

const system = `You are the JOB SELECTOR for a cash-starved autonomous software worker-business. Do not reveal private chain-of-thought. Choose at most one candidate and return compact JSON only.\n\nCURRENT MODE: ${firstRevenueMissing ? 'SURVIVAL: first confirmed cash is more important than headline reward.' : 'GROWTH: maximize reliable expected profit.'}\n\nSelection policy:\n- Optimize probability of receiving money soon, not advertised bounty size.\n- In survival mode prefer work likely finishable in <= 8 hours, ideally <= 4 hours.\n- Strongly prefer high payoutConfidence, high autonomyFit, low competition, clear acceptance criteria, ordinary software stacks, and zero-cost execution.\n- Reject any candidate requiring human assignment/claim, KYC, special hardware, device validation, paid infrastructure, deception, spam, regulated work, or unclear payout.\n- Treat a $50 task that can be completed and paid today as better than a $7000 task that may take days or need approval/hardware.\n- Account for probability of acceptance and payment.\n- If none is realistically fast and payable, choose null.\n\nReturn VALID JSON only:\n{"id":string|null,"confidence":number,"rationale":string,"expectedHours":number|null,"timeToCashHours":number|null,"expectedCostUsd":number|null}\nKeep rationale under 220 characters.`;

try {
  const result = await callOpenCode([
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(candidates.map((x) => ({
      id: x.id,
      title: x.title,
      rewardUsd: x.rewardUsd,
      fastCashScore: x.fastCashScore,
      payoutConfidence: x.payoutConfidence,
      autonomyFit: x.autonomyFit,
      estimatedHoursBand: x.estimatedHoursBand,
      survivalEligible: x.survivalEligible,
      eligibilityReason: x.eligibilityReason,
      competition: x.competition || null,
      labels: x.labels,
      summary: x.summary,
      url: x.url,
    }))) },
  ], { maxTokens: 1400, temperature: 0.05, timeoutMs: 50000 });

  const decision = parseJson(result.content);
  if (!decision || (!decision.id && decision.id !== null)) throw new Error('Selector returned invalid JSON.');
  const selected = decision.id ? candidates.find((x) => x.id === decision.id) : null;
  if (decision.id && !selected) throw new Error('Selector chose an unknown candidate.');

  const expectedHours = Number.isFinite(Number(decision.expectedHours)) ? Number(decision.expectedHours) : (selected?.estimatedHoursBand ?? null);
  const expectedCostUsd = Number.isFinite(Number(decision.expectedCostUsd)) ? Math.max(0, Number(decision.expectedCostUsd)) : 0;
  const timeToCashHours = Number.isFinite(Number(decision.timeToCashHours)) ? Math.max(0, Number(decision.timeToCashHours)) : expectedHours;

  let approved = selected;
  let rejectReason = '';
  if (approved && firstRevenueMissing && expectedHours > 8) {
    rejectReason = 'Model estimated more than 8 hours, too slow for survival mode.';
    approved = null;
  }
  if (approved && (approved.requiresHumanGate || approved.requiresSpecialHardware || approved.survivalEligible === false && firstRevenueMissing)) {
    rejectReason = 'Candidate violates survival autonomy constraints.';
    approved = null;
  }

  jobs.selected = approved ? { ...approved, state: 'selected' } : null;
  jobs.selection = {
    status: approved ? 'selected' : 'none',
    mode: firstRevenueMissing ? 'survival' : 'growth',
    confidence: Math.max(0, Math.min(1, Number(decision.confidence) || 0)),
    rationale: clean(rejectReason || decision.rationale, 220),
    expectedHours,
    timeToCashHours,
    expectedCostUsd,
    estimatedProfitUsd: approved ? Math.max(0, Number(approved.rewardUsd || 0) - expectedCostUsd) : 0,
    payoutConfidence: approved ? approved.payoutConfidence : null,
    autonomyFit: approved ? approved.autonomyFit : null,
    provider: { mode: result.mode, model: result.model, attempts: result.attempts },
  };
  jobs.status = approved ? 'selected' : 'idle';
  jobs.needsSelection = false;
  jobs.marketChanged = false;
  jobs.lastError = null;
  jobs.retryAfterAt = null;
} catch (error) {
  if (isProviderUnavailableError(error)) {
    jobs.status = 'selector_waiting_provider';
    jobs.needsSelection = true;
    jobs.lastError = clean(error.message, 300);
    const retrySeconds = Number(error?.retryAfterSeconds || 600);
    jobs.retryAfterAt = new Date(Date.now() + retrySeconds * 1000).toISOString();
  } else {
    jobs.status = 'selector_degraded';
    jobs.needsSelection = false;
    jobs.lastError = clean(error instanceof Error ? error.message : String(error), 300);
    jobs.retryAfterAt = null;
  }
}

jobs.updatedAt = new Date().toISOString();
await fs.writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
console.log(`Autonomous selector: ${jobs.status}; selected=${jobs.selected?.title || 'none'}; mode=${jobs.selection?.mode || 'unknown'}`);

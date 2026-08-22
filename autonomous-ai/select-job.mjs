import fs from 'node:fs/promises';
import path from 'node:path';
import { callOpenCode, isProviderUnavailableError } from './provider.mjs';

const JOBS_PATH = path.join(process.cwd(), 'autonomous-ai/jobs.json');

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

const jobs = JSON.parse(await fs.readFile(JOBS_PATH, 'utf8'));
const candidates = (jobs.opportunities || []).slice(0, 10);

if (!candidates.length) {
  jobs.selected = null;
  jobs.selection = { status: 'none', rationale: 'No verified paid candidate passed scouting and competition filters.' };
  jobs.status = 'idle';
  jobs.needsSelection = false;
  jobs.marketChanged = false;
  jobs.lastError = null;
  jobs.retryAfterAt = null;
  await fs.writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
  console.log('Autonomous selector: no candidate');
  process.exit(0);
}

const system = `You are the public JOB SELECTOR for an autonomous software worker-business. Choose at most one job from the supplied candidates. Do not reveal private chain-of-thought; provide only the compact decision fields requested.\n\nSelection policy:\n- Prefer legitimate, bounded coding/docs/data work with objective acceptance criteria.\n- Maximize expected value, not headline payout. Consider reward, likely hours, complexity, competition, probability of acceptance, and required credentials.\n- Treat competition.attemptSignals above 5 as saturated and reject it. Heavily penalize high comment counts even when exact active attempts are unknown.\n- Prefer a lower-paying task with low competition over a crowded task with a large advertised reward.\n- Reject referral promotions, speculative trading, spam, harmful security exploitation, regulated professional work, identity/KYC requirements, or tasks requiring deception.\n- Reject a task if payout evidence is vague or the candidate is a meta-list/aggregator rather than the actual paid task.\n- The worker has general JS/TS/Node/React/API/docs/data/bash/Python capability and can learn ordinary open-source codebases.\n- Missing wallet configuration does not prevent preparing work.\n\nReturn VALID JSON only with exactly these fields:\n{"id":string|null,"confidence":number,"rationale":string,"expectedHours":number|null,"expectedCostUsd":number|null,"estimatedProfitUsd":number|null}\nKeep rationale under 220 characters.`;

try {
  const result = await callOpenCode([
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(candidates.map((x) => ({
      id: x.id,
      title: x.title,
      rewardUsd: x.rewardUsd,
      score: x.score,
      labels: x.labels,
      summary: x.summary,
      url: x.url,
      commentCount: x.commentCount,
      competition: x.competition || null,
    }))) },
  ], { maxTokens: 1800, temperature: 0.1, timeoutMs: 50000 });

  const decision = parseJson(result.content);
  if (!decision || (!decision.id && decision.id !== null)) throw new Error('Selector returned invalid JSON.');

  const selected = decision.id ? candidates.find((x) => x.id === decision.id) : null;
  if (decision.id && !selected) throw new Error('Selector chose an unknown candidate.');
  if (selected && Number(selected.competition?.attemptSignals || 0) > 5) throw new Error('Selector chose a saturated candidate.');

  jobs.selected = selected ? { ...selected, state: 'selected' } : null;
  jobs.selection = {
    status: selected ? 'selected' : 'none',
    confidence: Math.max(0, Math.min(1, Number(decision.confidence) || 0)),
    rationale: clean(decision.rationale, 220),
    expectedHours: Number.isFinite(Number(decision.expectedHours)) ? Number(decision.expectedHours) : null,
    expectedCostUsd: Number.isFinite(Number(decision.expectedCostUsd)) ? Number(decision.expectedCostUsd) : null,
    estimatedProfitUsd: Number.isFinite(Number(decision.estimatedProfitUsd)) ? Number(decision.estimatedProfitUsd) : null,
    provider: { mode: result.mode, model: result.model, attempts: result.attempts },
  };
  jobs.status = selected ? 'selected' : 'idle';
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
  // Preserve the previous viable selection during temporary provider failures.
}

jobs.updatedAt = new Date().toISOString();
await fs.writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
console.log(`Autonomous selector: ${jobs.status}; selected=${jobs.selected?.title || 'none'}`);

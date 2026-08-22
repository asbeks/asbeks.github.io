import fs from 'node:fs/promises';
import path from 'node:path';

const JOBS_PATH = path.join(process.cwd(), 'autonomous-ai/jobs.json');
const FREE_URL = 'https://opencode.ai/inference/openai/v1/chat/completions';
const FREE_MODEL = 'mimo-v2.5-free';

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

async function callModel(messages) {
  const budgets = [900, 1500, 2200];
  let lastError = new Error('Job selector failed.');
  for (let i = 0; i < budgets.length; i += 1) {
    try {
      const response = await fetch(FREE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: FREE_MODEL, messages, stream: false, temperature: 0.1, max_tokens: budgets[i] }),
        signal: AbortSignal.timeout(45000),
      });
      const body = await response.json().catch(() => ({}));
      const content = body?.choices?.[0]?.message?.content;
      if (response.ok && typeof content === 'string' && content.trim()) return content;
      lastError = new Error(body?.error?.message || `Selector HTTP ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (i < budgets.length - 1) await new Promise((resolve) => setTimeout(resolve, 1200 * (i + 1)));
  }
  throw lastError;
}

const jobs = JSON.parse(await fs.readFile(JOBS_PATH, 'utf8'));
const candidates = (jobs.opportunities || []).slice(0, 10);

if (!candidates.length) {
  jobs.selected = null;
  jobs.selection = { status: 'none', rationale: 'No verified paid candidate passed the deterministic scout.' };
  jobs.status = 'idle';
  await fs.writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
  console.log('Autonomous selector: no candidate');
  process.exit(0);
}

const system = `You are the public JOB SELECTOR for an autonomous software worker-business. Choose at most one job from the supplied candidates. Do not reveal private chain-of-thought; provide only the compact decision fields requested.\n\nSelection policy:\n- Prefer legitimate, bounded coding/docs/data work with objective acceptance criteria.\n- Prefer higher expected profit, but do not choose a large payout if the task is likely too complex or requires credentials/accounts we do not have.\n- Reject referral promotions, speculative trading, spam, harmful security exploitation, regulated professional work, identity/KYC requirements, or tasks requiring deception.\n- Reject a task if payout evidence is too vague or the candidate looks like a meta-list/aggregator rather than the actual paid task.\n- The worker currently has general JS/TS/Node/React/API/docs/data capability and can learn ordinary open-source codebases.\n- Missing wallet configuration does not prevent preparing work, but it lowers usefulness if the reward cannot later be collected.\n\nReturn VALID JSON only with exactly these fields:\n{"id":string|null,"confidence":number,"rationale":string,"expectedHours":number|null,"expectedCostUsd":number|null,"estimatedProfitUsd":number|null}\nKeep rationale under 220 characters.`;

try {
  const content = await callModel([
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(candidates.map((x) => ({ id: x.id, title: x.title, rewardUsd: x.rewardUsd, score: x.score, labels: x.labels, summary: x.summary, url: x.url }))) },
  ]);
  const decision = parseJson(content);
  if (!decision || (!decision.id && decision.id !== null)) throw new Error('Selector returned invalid JSON.');

  const selected = decision.id ? candidates.find((x) => x.id === decision.id) : null;
  if (decision.id && !selected) throw new Error('Selector chose an unknown candidate.');

  jobs.selected = selected ? { ...selected, state: 'selected' } : null;
  jobs.selection = {
    status: selected ? 'selected' : 'none',
    confidence: Math.max(0, Math.min(1, Number(decision.confidence) || 0)),
    rationale: clean(decision.rationale, 220),
    expectedHours: Number.isFinite(Number(decision.expectedHours)) ? Number(decision.expectedHours) : null,
    expectedCostUsd: Number.isFinite(Number(decision.expectedCostUsd)) ? Number(decision.expectedCostUsd) : null,
    estimatedProfitUsd: Number.isFinite(Number(decision.estimatedProfitUsd)) ? Number(decision.estimatedProfitUsd) : null,
  };
  jobs.status = selected ? 'selected' : 'idle';
  jobs.lastError = null;
} catch (error) {
  jobs.selected = null;
  jobs.selection = null;
  jobs.status = 'selector_degraded';
  jobs.lastError = clean(error instanceof Error ? error.message : String(error), 300);
}

jobs.updatedAt = new Date().toISOString();
await fs.writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
console.log(`Autonomous selector: ${jobs.status}; selected=${jobs.selected?.title || 'none'}`);

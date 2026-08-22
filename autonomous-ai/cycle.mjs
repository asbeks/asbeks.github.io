import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_PATH = path.join(process.cwd(), 'autonomous-ai/state.json');
const ECONOMY_PATH = path.join(process.cwd(), 'autonomous-ai/economy.json');
const FREE_URL = 'https://opencode.ai/inference/openai/v1/chat/completions';
const FREE_MODEL = 'mimo-v2.5-free';
const MISSION = 'Operate a small economically self-sustaining AI that earns legitimate revenue, manages a crypto operating budget, pays infrastructure costs through a policy-gated signer, preserves reserves, improves its software, and scales only when economically justified.';

async function readState() {
  return JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
}

async function readEconomy() {
  try { return JSON.parse(await fs.readFile(ECONOMY_PATH, 'utf8')); }
  catch { return { status: 'unavailable', balances: {}, totals: {}, ledger: [] }; }
}

function compactHistory(history = []) {
  return history.slice(-4).map((item) => ({
    cycle: item.cycle,
    agent: item.agent,
    observation: item.observation,
    objection: item.objection,
    decision: item.decision,
    next: item.next,
  }));
}

function compactEconomy(economy = {}) {
  return {
    status: economy.status,
    balances: economy.balances || {},
    totals: economy.totals || {},
    runwayDays: economy.runwayDays ?? null,
    walletConfigured: Boolean(economy.wallets?.tonAddress || economy.wallets?.tronAddress),
    recentLedger: (economy.ledger || []).slice(-5).map((x) => ({ chain: x.chain, asset: x.asset, type: x.type, amount: x.amount, timestamp: x.timestamp })),
    lastError: economy.lastError || null,
  };
}

function parseJson(content) {
  const cleaned = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  const out = {};
  for (const key of ['observation', 'objection', 'decision', 'next']) {
    const label = new RegExp(`(?:^|\\n)\\s*(?:\\*\\*)?${key}(?:\\*\\*)?\\s*[:\\-]\\s*["']?([^\\n"']+)`, 'i');
    const found = cleaned.match(label);
    if (found?.[1]) out[key] = found[1].trim();
  }
  return Object.keys(out).length === 4 ? out : null;
}

function clean(value, max = 220) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function rawCall(messages, maxTokens, temperature = 0.2) {
  const response = await fetch(FREE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: FREE_MODEL, messages, stream: false, temperature, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(45000),
  });
  const data = await response.json().catch(() => ({}));
  const content = data?.choices?.[0]?.message?.content;
  if (!response.ok || typeof content !== 'string' || !content.trim()) {
    const reason = data?.error?.message || (response.ok ? 'HTTP 200 with empty visible output' : `HTTP ${response.status}`);
    throw new Error(`OpenCode request failed: ${reason}`);
  }
  return content;
}

async function callModel(messages) {
  const budgets = [900, 1600, 2400];
  let lastError = new Error('OpenCode request failed.');
  for (let attempt = 0; attempt < budgets.length; attempt += 1) {
    try { return await rawCall(messages, budgets[attempt], 0.2); }
    catch (error) { lastError = error instanceof Error ? error : new Error(String(error)); }
    if (attempt < budgets.length - 1) await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  throw lastError;
}

async function repairTrace(content) {
  const repaired = await rawCall([
    { role: 'system', content: 'Convert the supplied PUBLIC reasoning summary into valid JSON only. Do not add new facts. Return exactly four string fields: observation, objection, decision, next.' },
    { role: 'user', content: String(content || '').slice(0, 5000) },
  ], 700, 0);
  return parseJson(repaired);
}

const [state, economy] = await Promise.all([readState(), readEconomy()]);
const nextCycle = Number(state.cycle || 0) + 1;
const agent = nextCycle % 2 === 1 ? 'PLANNER' : 'CRITIC';
const otherAgent = agent === 'PLANNER' ? 'CRITIC' : 'PLANNER';
const economySnapshot = compactEconomy(economy);

const system = `You are ${agent}, one role in an autonomous engineering and economic operating loop. Publish a SHORT PUBLIC REASONING TRACE only. Do not reveal private chain-of-thought. Give only concise conclusions and rationale deliberately intended for observers.\n\nMISSION: ${MISSION}\n\nThe ECONOMY snapshot supplied by the user message is authoritative. Never invent revenue, balances, costs, deposits, or wallet configuration. If the treasury is unconfigured, explicitly treat wallet provisioning as the blocker instead of pretending capital exists.\n\nRules:\n- Return VALID JSON only, with no prose before or after it.\n- Exactly four string fields: observation, objection, decision, next.\n- Each field is one short sentence, maximum 180 characters.\n- Be concrete, engineering-focused, financially realistic, and act on measured results.\n- ${agent === 'PLANNER' ? 'Choose the smallest useful next move based on the real economy and directly address the latest critique.' : 'Challenge the latest plan against the real economy, identify the most important failure mode, then refine the next move.'}\n- Do not execute external actions from this reasoning process.\n- Do not propose uncontrolled replication, evading shutdown, credential theft, unauthorized access, hiding activity, raw key exposure, or removal of the signer policy kernel.\n- The next field should tell ${otherAgent} what to examine next.`;

const publicState = {
  cycle: nextCycle,
  previousAgent: state.latest?.agent || null,
  previous: state.latest || null,
  recentHistory: compactHistory(state.history),
  economy: economySnapshot,
};

try {
  const content = await callModel([
    { role: 'system', content: system },
    { role: 'user', content: `Continue from this measured public state:\n${JSON.stringify(publicState)}` },
  ]);
  let parsed = parseJson(content);
  if (!parsed) parsed = await repairTrace(content);
  if (!parsed) throw new Error('Model output could not be normalized into the public trace schema.');

  const entry = {
    cycle: nextCycle,
    agent,
    timestamp: new Date().toISOString(),
    observation: clean(parsed.observation),
    objection: clean(parsed.objection),
    decision: clean(parsed.decision),
    next: clean(parsed.next),
  };
  state.version = 3;
  state.cycle = nextCycle;
  state.updatedAt = entry.timestamp;
  state.mission = MISSION;
  state.status = 'online';
  state.currentAgent = agent;
  state.provider = { mode: 'OpenCode Free', model: FREE_MODEL };
  state.economy = economySnapshot;
  state.latest = entry;
  state.lastError = null;
  state.history = [...(state.history || []), entry].slice(-40);
} catch (error) {
  state.status = 'degraded';
  state.updatedAt = new Date().toISOString();
  state.currentAgent = agent;
  state.economy = economySnapshot;
  state.lastError = clean(error instanceof Error ? error.message : String(error), 300);
}

await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
console.log(`Autonomous AI cycle ${nextCycle}: ${state.status}; economy=${economy.status}`);

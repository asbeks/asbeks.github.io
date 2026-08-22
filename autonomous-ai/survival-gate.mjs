import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.join(process.cwd(), 'autonomous-ai');
const jobsPath = path.join(root, 'jobs.json');
const economyPath = path.join(root, 'economy.json');
const outputPath = process.env.GITHUB_OUTPUT || '';

async function readJson(file, fallback = {}) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function emit(values) {
  const text = Object.entries(values).map(([k, v]) => `${k}=${String(v)}`).join('\n') + '\n';
  if (outputPath) await fs.appendFile(outputPath, text);
  console.log(text.trim());
}

function selectedText(selected) {
  return `${selected?.title || ''} ${selected?.summary || ''} ${(selected?.labels || []).join(' ')}`.toLowerCase();
}

function testMoney(selected) {
  return /\btestnet\b|\btest tokens?\b|\btest usdc\b|\bfaucet tokens?\b|\bdevnet\b|\bsepolia\b|\bgoerli\b|\barc[- ]testnet\b/.test(selectedText(selected));
}

function alreadyPaid(selected) {
  const labels = (selected?.labels || []).map((x) => String(x).toLowerCase());
  return labels.some((x) => x.includes('💰 rewarded') || /^(paid|rewarded|bounty paid|completed bounty|claimed)$/.test(x.replace(/[^a-z ]/g, '').trim()));
}

const jobs = await readJson(jobsPath, { completed: [] });
const economy = await readJson(economyPath, {});
const selected = jobs.selected || null;
const revenue = Number(economy?.totals?.revenueUSDT || 0);
const survivalMode = revenue <= 0 && (jobs.completed || []).length === 0;

let allowed = Boolean(selected);
let reason = selected ? 'selected_job_passes_worker_gate' : 'no_selected_job';

if (selected) {
  if (testMoney(selected) || selected.realMoneyEligible === false || Number(selected.economicValueUsd ?? selected.rewardUsd ?? 0) <= 0) {
    allowed = false;
    reason = 'not_real_spendable_money';
  } else if (alreadyPaid(selected)) {
    allowed = false;
    reason = 'already_rewarded_or_paid';
  } else if (selected.requiresHumanGate) {
    allowed = false;
    reason = 'human_claim_or_identity_gate';
  } else if (selected.requiresSpecialHardware) {
    allowed = false;
    reason = 'special_hardware_required';
  } else if (Number(selected.payoutConfidence || 0) < 0.55) {
    allowed = false;
    reason = 'payout_not_verified_enough';
  } else if (Number(selected.autonomyFit || 0) < 0.75) {
    allowed = false;
    reason = 'low_autonomy_fit';
  } else if (['high', 'saturated'].includes(String(selected.competition?.risk || '')) && survivalMode) {
    allowed = false;
    reason = 'competition_too_high_for_first_cash';
  } else if (survivalMode && Number(selected.estimatedHoursBand || 99) > 8) {
    allowed = false;
    reason = 'too_slow_for_first_cash';
  } else if (survivalMode && selected.survivalEligible !== true) {
    allowed = false;
    reason = 'not_survival_eligible';
  }
}

if (selected && !allowed) {
  jobs.rejected = [
    { id: selected.id, title: selected.title, reason, rejectedAt: new Date().toISOString() },
    ...(jobs.rejected || []).filter((x) => x.id !== selected.id),
  ].slice(0, 40);
  jobs.selected = null;
  jobs.active = null;
  jobs.status = 'idle';
  jobs.selection = {
    ...(jobs.selection || {}),
    status: 'rejected_by_worker_gate',
    rationale: `Worker refused job: ${reason}. Continue scouting for faster real cash.`,
  };
  jobs.needsSelection = false;
  jobs.updatedAt = new Date().toISOString();
  await fs.writeFile(jobsPath, JSON.stringify(jobs, null, 2) + '\n');
}

await emit({
  run: allowed ? 'true' : 'false',
  mode: survivalMode ? 'survival' : 'growth',
  reason,
});

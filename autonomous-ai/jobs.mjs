import fs from 'node:fs/promises';
import path from 'node:path';

const JOBS_PATH = path.join(process.cwd(), 'autonomous-ai/jobs.json');
const API = 'https://api.github.com/search/issues';
const MAX_RESULTS = 24;
const MIN_REWARD_USD = 10;
const MAX_COMMENTS = 80;
const MAX_ATTEMPT_SIGNALS = 5;

function clean(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function marketSignature(items = []) {
  return JSON.stringify(items.map((x) => ({
    id: x.id,
    rewardUsd: x.rewardUsd ?? null,
    fastCashScore: x.fastCashScore ?? null,
    updatedAt: x.updatedAt || null,
    competition: x.competition || null,
  })).sort((a, b) => String(a.id).localeCompare(String(b.id))));
}

function parseReward(text = '', labels = []) {
  for (const label of labels) {
    const match = String(label).match(/^\$\s*([0-9][0-9,]*(?:\.\d+)?)$/);
    if (match) {
      const amount = Number(match[1].replace(/,/g, ''));
      if (Number.isFinite(amount) && amount > 0 && amount <= 100000) return amount;
    }
  }
  const patterns = [
    /(?:USDT|USD)\s*[$:]?\s*([0-9][0-9,]*(?:\.\d+)?)/i,
    /\$\s*([0-9][0-9,]*(?:\.\d+)?)/,
    /([0-9][0-9,]*(?:\.\d+)?)\s*(?:USDT|USD)\b/i,
  ];
  for (const pattern of patterns) {
    const match = String(text).match(pattern);
    if (!match) continue;
    const amount = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(amount) && amount > 0 && amount <= 100000) return amount;
  }
  return null;
}

function isBlocked(text = '') {
  const s = String(text).toLowerCase();
  return [
    'exploit', '0day', 'zero-day', 'steal', 'credential stuffing', 'phishing',
    'malware', 'ransomware', 'ddos', 'botnet', 'bypass authentication', 'weapon',
    'fraud', 'fake review', 'spam campaign', 'medical diagnosis', 'legal advice',
    'investment advice', 'casino', 'gambling', 'bounty alert', 'opportunity radar',
    'global cash promoter', 'referral code', 'code de parrainage', 'trading bonus',
    'affiliate bonus', 'find other bounties', 'search fresh open github bounty',
  ].some((term) => s.includes(term));
}

function classifyCandidate(issue, candidate) {
  const labels = candidate.labels || [];
  const text = `${candidate.title} ${candidate.summary}`.toLowerCase();
  const repoUrl = String(issue.repository_url || '');
  const isTenstorrent = /\/repos\/tenstorrent\/tt-metal$/i.test(repoUrl);
  const hasBountyLabel = labels.some((x) => /^bounty$/i.test(x));
  const hasDifficultyLabel = labels.some((x) => /^bounty_difficulty\//i.test(x));
  const hasPaidLabel = labels.some((x) => /bounty|reward|paid/i.test(x));
  const hasAlgoraBounty = labels.some((x) => /💎\s*bounty/i.test(x));
  const hasAmountLabel = labels.some((x) => /^\$\s*[0-9]/.test(x));
  const hasAcceptance = /acceptance criteria|success criteria|definition of done|deliverables/.test(text);
  const titleBounty = /\bbounty\b/.test(candidate.title.toLowerCase());

  const assignmentGate = /request assignment|assigned before|assignment before|before opening the pr|before i open the pr|accepted into the .*bounty program|maintainer approval/.test(text);
  const identityGate = /\bkyc\b|identity verification|fill out .*form|join .*slack|legal name|tax form/.test(text);
  const requiresHumanGate = Boolean(assignmentGate || identityGate || isTenstorrent);

  const requiresSpecialHardware = /tenstorrent hardware|wormhole|blackhole|\bn150\b|\bn300\b|\bt3k\b|device validation|device ci|silicon|hardware validation|hardware benchmark|cuda gpu|gpu required/.test(text);

  let complexity = 0;
  if (/\bc\+\+\b|kernel|sfpu|cuda|assembly|compiler|firmware/.test(text)) complexity += 4;
  if (/wormhole|blackhole|multi-arch|architecture-aware/.test(text)) complexity += 3;
  if (/performance|benchmark|profiling|optimization|optimisation/.test(text)) complexity += 2;
  if (/stage 1|stage 2|stage 3|model bring.?up|end-to-end model/.test(text)) complexity += 5;
  if (/documentation|docs|changelog|json|yaml|typescript|javascript|node\.js|react|small fix|single file|config/.test(text)) complexity -= 2;
  complexity = Math.max(0, complexity);

  const estimatedHoursBand = requiresSpecialHardware ? 30 : complexity >= 8 ? 24 : complexity >= 5 ? 16 : complexity >= 3 ? 8 : 4;

  let payoutConfidence = 0.35;
  if (hasAlgoraBounty && hasAmountLabel) payoutConfidence = 0.92;
  else if (hasPaidLabel && titleBounty && hasAcceptance) payoutConfidence = 0.85;
  else if (titleBounty && hasAcceptance) payoutConfidence = 0.65;
  else if (hasPaidLabel && hasAcceptance) payoutConfidence = 0.7;
  else if (titleBounty) payoutConfidence = 0.5;

  // Tenstorrent's current public bounty process requires official bounty labels and human assignment.
  if (isTenstorrent) payoutConfidence = hasBountyLabel && hasDifficultyLabel ? 0.8 : 0.15;

  let autonomyFit = 1;
  if (requiresHumanGate) autonomyFit -= 0.55;
  if (requiresSpecialHardware) autonomyFit -= 0.45;
  autonomyFit = Math.max(0, autonomyFit);

  const competitionPenalty = Math.min(35, Number(candidate.commentCount || 0) * 1.5);
  const rewardUtility = Math.min(30, Math.log2(candidate.rewardUsd + 1) * 4);
  const speedUtility = estimatedHoursBand <= 4 ? 30 : estimatedHoursBand <= 8 ? 18 : estimatedHoursBand <= 16 ? 5 : -20;
  const fundedBonus = hasAlgoraBounty && hasAmountLabel ? 18 : 0;
  const fastCashScore = Math.round(
    payoutConfidence * 45 + autonomyFit * 35 + rewardUtility + speedUtility + fundedBonus - complexity * 4 - competitionPenalty,
  );

  const survivalEligible = Boolean(
    candidate.rewardUsd >= MIN_REWARD_USD
    && payoutConfidence >= 0.55
    && autonomyFit >= 0.75
    && !requiresHumanGate
    && !requiresSpecialHardware
    && estimatedHoursBand <= 8,
  );

  return {
    ...candidate,
    payoutConfidence: Number(payoutConfidence.toFixed(2)),
    autonomyFit: Number(autonomyFit.toFixed(2)),
    requiresHumanGate,
    requiresSpecialHardware,
    estimatedHoursBand,
    complexity,
    fundedBountySignal: Boolean(hasAlgoraBounty && hasAmountLabel),
    fastCashScore,
    survivalEligible,
    eligibilityReason: survivalEligible
      ? 'Fast-cash candidate: bounded, low-friction, no special hardware or human claim gate detected.'
      : requiresHumanGate
        ? 'Human claim/assignment/KYC gate detected.'
        : requiresSpecialHardware
          ? 'Special hardware or device validation appears required.'
          : payoutConfidence < 0.55
            ? 'Payout evidence is not strong enough.'
            : estimatedHoursBand > 8
              ? 'Likely too slow for first-revenue survival mode.'
              : 'Insufficient autonomous fit.',
  };
}

function baseCandidate(issue) {
  const title = clean(issue.title, 250);
  const body = clean(issue.body, 6000);
  const text = `${title} ${body}`;
  if (isBlocked(text)) return null;

  const labels = (issue.labels || []).map((x) => typeof x === 'string' ? x : x?.name).filter(Boolean);
  const lower = text.toLowerCase();
  const rewardUsd = parseReward(text, labels);
  const commentCount = Number(issue.comments || 0);
  if (rewardUsd === null || rewardUsd < MIN_REWARD_USD || commentCount > MAX_COMMENTS) return null;

  let score = 0;
  if (lower.includes('bounty')) score += 14;
  if (lower.includes('reward')) score += 8;
  if (lower.includes('paid')) score += 8;
  if (lower.includes('usdt')) score += 8;
  if (labels.some((x) => /help wanted/i.test(x))) score += 8;
  if (labels.some((x) => /bounty|reward|paid/i.test(x))) score += 10;
  if (labels.some((x) => /💎\s*bounty/i.test(x))) score += 18;
  if (rewardUsd >= 25) score += 10;
  if (/documentation|docs|typescript|javascript|node|react|api|bug|feature|column|field|test|bash|python|json|yaml/i.test(text)) score += 12;
  if (/acceptance criteria|definition of done|requirements|deliverables/i.test(text)) score += 8;
  if (commentCount > 30) score -= 30;
  else if (commentCount > 15) score -= 18;
  else if (commentCount > 5) score -= 8;

  const ageDays = Math.max(0, (Date.now() - new Date(issue.updated_at).getTime()) / 86400000);
  score += Math.max(0, 10 - Math.floor(ageDays / 3));
  if (!issue.repository_url || !issue.html_url) return null;

  return classifyCandidate(issue, {
    id: `github:${issue.id}`,
    source: 'github',
    title,
    url: issue.html_url,
    repositoryApiUrl: issue.repository_url,
    commentsApiUrl: issue.comments_url || null,
    rewardUsd,
    score,
    labels,
    commentCount,
    updatedAt: issue.updated_at,
    summary: clean(body, 1200),
    state: 'candidate',
  });
}

function attemptSignal(text = '') {
  return /\/opire\s+try\b|(?:^|\s)\/try\b|i(?:'|’)ll\s+(?:take|work)|working\s+on\s+this|claim(?:ing)?\s+this/i.test(String(text));
}

async function inspectCompetition(candidate, headers) {
  if (!candidate.commentsApiUrl || candidate.commentCount === 0) {
    return { ...candidate, competition: { comments: candidate.commentCount, attemptSignals: 0, risk: 'low' } };
  }
  const response = await fetch(`${candidate.commentsApiUrl}?per_page=100`, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    return { ...candidate, competition: { comments: candidate.commentCount, attemptSignals: null, risk: candidate.commentCount > 15 ? 'high' : 'unknown' } };
  }
  const comments = await response.json().catch(() => []);
  const attemptSignals = Array.isArray(comments) ? comments.filter((x) => attemptSignal(x?.body)).length : 0;
  const risk = attemptSignals > MAX_ATTEMPT_SIGNALS ? 'saturated' : attemptSignals > 2 || candidate.commentCount > 15 ? 'high' : attemptSignals > 0 || candidate.commentCount > 5 ? 'medium' : 'low';
  return {
    ...candidate,
    fastCashScore: candidate.fastCashScore - Math.min(35, attemptSignals * 8),
    competition: { comments: candidate.commentCount, attemptSignals, risk },
  };
}

async function search(query, headers) {
  const url = `${API}?per_page=20&sort=updated&order=desc&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || `GitHub search failed (${response.status})`);
  return Array.isArray(body.items) ? body.items : [];
}

async function readJobs() {
  try { return JSON.parse(await fs.readFile(JOBS_PATH, 'utf8')); }
  catch { return { version: 1, opportunities: [], completed: [] }; }
}

const jobs = await readJobs();
const previousSignature = jobs.marketSignature || marketSignature(jobs.opportunities || []);
const previousSelected = jobs.selected || null;
const previousSelection = jobs.selection || null;
const since = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'autonomous-ai-job-scout',
};
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const queries = [
  `is:issue is:open label:"💎 Bounty" updated:>=${since}`,
  `is:issue is:open bounty in:title,body updated:>=${since}`,
  `is:issue is:open reward in:title,body updated:>=${since}`,
  `is:issue is:open USDT in:title,body updated:>=${since}`,
  `is:issue is:open paid in:title,body label:"help wanted" updated:>=${since}`,
  `is:issue is:open bounty docs OR documentation in:title,body updated:>=${since}`,
];

try {
  const pages = await Promise.all(queries.map((q) => search(q, headers)));
  const seen = new Set();
  const preliminary = [];
  for (const issue of pages.flat()) {
    if (seen.has(issue.id) || issue.pull_request) continue;
    seen.add(issue.id);
    const candidate = baseCandidate(issue);
    if (!candidate || candidate.score < 30) continue;
    preliminary.push(candidate);
  }

  preliminary.sort((a, b) => (b.fastCashScore - a.fastCashScore) || (b.score - a.score));
  const inspected = [];
  for (const candidate of preliminary.slice(0, 16)) {
    const checked = await inspectCompetition(candidate, headers);
    if (checked.competition?.risk === 'saturated') continue;
    if (Number(checked.competition?.attemptSignals || 0) > MAX_ATTEMPT_SIGNALS) continue;
    delete checked.commentsApiUrl;
    inspected.push(checked);
  }

  inspected.sort((a, b) => (b.fastCashScore - a.fastCashScore) || (b.rewardUsd - a.rewardUsd));
  const nextOpportunities = inspected.slice(0, MAX_RESULTS);
  const nextSignature = marketSignature(nextOpportunities);
  const marketChanged = nextSignature !== previousSignature;
  const selectedStillExists = previousSelected?.id && nextOpportunities.some((x) => x.id === previousSelected.id);

  jobs.version = 7;
  jobs.updatedAt = new Date().toISOString();
  jobs.source = 'github-public-issues';
  jobs.opportunities = nextOpportunities;
  jobs.marketSignature = nextSignature;
  jobs.marketChanged = marketChanged;
  jobs.survival = {
    mode: (jobs.completed || []).length === 0,
    eligibleCount: nextOpportunities.filter((x) => x.survivalEligible).length,
    fundedSignalCount: nextOpportunities.filter((x) => x.fundedBountySignal).length,
    objective: 'first_confirmed_cash_fast',
  };

  if (!marketChanged && previousSelection && selectedStillExists) {
    jobs.selected = previousSelected;
    jobs.selection = previousSelection;
    jobs.needsSelection = false;
    jobs.status = 'selected';
  } else {
    jobs.selected = null;
    jobs.selection = null;
    jobs.needsSelection = nextOpportunities.some((x) => x.survivalEligible) || ((jobs.completed || []).length > 0 && nextOpportunities.length > 0);
    jobs.status = jobs.needsSelection ? 'candidates' : 'idle';
  }
  jobs.lastError = null;
} catch (error) {
  jobs.updatedAt = new Date().toISOString();
  jobs.status = 'degraded';
  jobs.marketChanged = false;
  jobs.needsSelection = false;
  jobs.lastError = clean(error instanceof Error ? error.message : String(error), 300);
}

await fs.writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
console.log(`Autonomous job scout: ${jobs.status}; opportunities=${jobs.opportunities?.length || 0}; survivalEligible=${jobs.survival?.eligibleCount || 0}; fundedSignals=${jobs.survival?.fundedSignalCount || 0}`);

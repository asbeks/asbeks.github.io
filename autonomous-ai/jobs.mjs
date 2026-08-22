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
  return JSON.stringify((items || []).map((x) => ({
    id: x.id,
    rewardUsd: x.rewardUsd ?? null,
    score: x.score ?? null,
    updatedAt: x.updatedAt || null,
    competition: x.competition ? {
      comments: x.competition.comments ?? null,
      attemptSignals: x.competition.attemptSignals ?? null,
      risk: x.competition.risk || null,
    } : null,
  })).sort((a, b) => String(a.id).localeCompare(String(b.id))));
}

function parseReward(text = '') {
  const s = String(text);
  const patterns = [
    /(?:USDT|USD)\s*[$:]?\s*([0-9][0-9,]*(?:\.\d+)?)/i,
    /\$\s*([0-9][0-9,]*(?:\.\d+)?)/,
    /([0-9][0-9,]*(?:\.\d+)?)\s*(?:USDT|USD)\b/i,
  ];
  for (const pattern of patterns) {
    const match = s.match(pattern);
    if (!match) continue;
    const amount = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(amount) && amount > 0 && amount <= 100000) return amount;
  }
  return null;
}

function isBlocked(text = '') {
  const s = String(text).toLowerCase();
  const blocked = [
    'exploit', '0day', 'zero-day', 'steal', 'credential stuffing', 'phishing',
    'malware', 'ransomware', 'ddos', 'botnet', 'bypass authentication',
    'weapon', 'fraud', 'fake review', 'spam campaign', 'medical diagnosis',
    'legal advice', 'investment advice', 'casino', 'gambling',
    'bounty alert', 'opportunity radar', 'global cash promoter',
    'referral code', 'code de parrainage', 'trading bonus', 'affiliate bonus',
    'find other bounties', 'search fresh open github bounty',
  ];
  return blocked.some((term) => s.includes(term));
}

function baseCandidate(issue) {
  const title = clean(issue.title, 250);
  const body = clean(issue.body, 1800);
  const text = `${title} ${body}`;
  if (isBlocked(text)) return null;

  const labels = (issue.labels || []).map((x) => typeof x === 'string' ? x : x?.name).filter(Boolean);
  const lower = text.toLowerCase();
  const rewardUsd = parseReward(text);
  const commentCount = Number(issue.comments || 0);
  if (rewardUsd === null || rewardUsd < MIN_REWARD_USD) return null;
  if (commentCount > MAX_COMMENTS) return null;

  let score = 0;
  if (lower.includes('bounty')) score += 14;
  if (lower.includes('reward')) score += 8;
  if (lower.includes('paid')) score += 8;
  if (lower.includes('usdt')) score += 8;
  if (labels.some((x) => /help wanted/i.test(x))) score += 8;
  if (labels.some((x) => /bounty|reward|paid/i.test(x))) score += 10;
  if (rewardUsd >= 25) score += 12;
  if (rewardUsd >= 75) score += 8;
  if (rewardUsd >= 200) score += 6;
  if (/documentation|docs|typescript|javascript|node|react|api|bug|feature|column|field|test|bash|python/i.test(text)) score += 12;
  if (/acceptance criteria|definition of done|requirements/i.test(text)) score += 8;
  if (/fill out.*form|join.*slack|kyc|identity verification|needs reproduction/i.test(text)) score -= 12;

  if (commentCount > 30) score -= 30;
  else if (commentCount > 15) score -= 18;
  else if (commentCount > 5) score -= 8;

  const ageDays = Math.max(0, (Date.now() - new Date(issue.updated_at).getTime()) / 86400000);
  score += Math.max(0, 10 - Math.floor(ageDays / 3));

  if (!issue.repository_url || !issue.html_url) return null;
  return {
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
    summary: clean(body, 520),
    state: 'candidate',
  };
}

function attemptSignal(text = '') {
  const s = String(text).toLowerCase();
  return /\/opire\s+try\b|(?:^|\s)\/try\b|i(?:'|’)ll\s+(?:take|work)|working\s+on\s+this|claim(?:ing)?\s+this/.test(s);
}

async function inspectCompetition(candidate, headers) {
  if (!candidate.commentsApiUrl || candidate.commentCount === 0) {
    return { ...candidate, competition: { comments: candidate.commentCount, attemptSignals: 0, risk: 'low' } };
  }

  const url = `${candidate.commentsApiUrl}?per_page=100`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    return { ...candidate, competition: { comments: candidate.commentCount, attemptSignals: null, risk: candidate.commentCount > 15 ? 'high' : 'unknown' } };
  }
  const comments = await response.json().catch(() => []);
  const attemptSignals = Array.isArray(comments) ? comments.filter((x) => attemptSignal(x?.body)).length : 0;
  const risk = attemptSignals > MAX_ATTEMPT_SIGNALS ? 'saturated' : attemptSignals > 2 || candidate.commentCount > 15 ? 'high' : attemptSignals > 0 || candidate.commentCount > 5 ? 'medium' : 'low';
  return { ...candidate, score: candidate.score - Math.min(30, attemptSignals * 5), competition: { comments: candidate.commentCount, attemptSignals, risk } };
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
  `is:issue is:open bounty in:title,body updated:>=${since}`,
  `is:issue is:open reward in:title,body updated:>=${since}`,
  `is:issue is:open USDT in:title,body updated:>=${since}`,
  `is:issue is:open paid in:title,body label:"help wanted" updated:>=${since}`,
];

try {
  const pages = await Promise.all(queries.map((q) => search(q, headers)));
  const seen = new Set();
  const preliminary = [];
  for (const issue of pages.flat()) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    if (issue.pull_request) continue;
    const candidate = baseCandidate(issue);
    if (!candidate || candidate.score < 35) continue;
    preliminary.push(candidate);
  }

  preliminary.sort((a, b) => (b.score - a.score) || ((b.rewardUsd || 0) - (a.rewardUsd || 0)));
  const inspected = [];
  for (const candidate of preliminary.slice(0, 14)) {
    const checked = await inspectCompetition(candidate, headers);
    if (checked.competition?.risk === 'saturated') continue;
    if (Number(checked.competition?.attemptSignals || 0) > MAX_ATTEMPT_SIGNALS) continue;
    if (checked.score < 38) continue;
    delete checked.commentsApiUrl;
    inspected.push(checked);
  }

  inspected.sort((a, b) => (b.score - a.score) || ((b.rewardUsd || 0) - (a.rewardUsd || 0)));
  const nextOpportunities = inspected.slice(0, MAX_RESULTS);
  const nextSignature = marketSignature(nextOpportunities);
  const marketChanged = nextSignature !== previousSignature;
  const selectedStillExists = previousSelected?.id && nextOpportunities.some((x) => x.id === previousSelected.id);

  jobs.version = 5;
  jobs.updatedAt = new Date().toISOString();
  jobs.source = 'github-public-issues';
  jobs.opportunities = nextOpportunities;
  jobs.marketSignature = nextSignature;
  jobs.marketChanged = marketChanged;

  if (!marketChanged && previousSelection) {
    jobs.selected = selectedStillExists ? previousSelected : null;
    jobs.selection = previousSelection;
    jobs.needsSelection = false;
    jobs.status = jobs.selected ? 'selected' : 'idle';
  } else {
    jobs.selected = null;
    jobs.selection = null;
    jobs.needsSelection = nextOpportunities.length > 0;
    jobs.status = nextOpportunities.length ? 'candidates' : 'idle';
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
console.log(`Autonomous job scout: ${jobs.status}; opportunities=${jobs.opportunities?.length || 0}; marketChanged=${Boolean(jobs.marketChanged)}`);

import fs from 'node:fs/promises';
import path from 'node:path';

const JOBS_PATH = path.join(process.cwd(), 'autonomous-ai/jobs.json');
const API = 'https://api.github.com/search/issues';
const MAX_RESULTS = 24;
const MIN_REWARD_USD = 10;

function clean(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
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

function scoreIssue(issue) {
  const title = clean(issue.title, 250);
  const body = clean(issue.body, 1800);
  const text = `${title} ${body}`;
  if (isBlocked(text)) return null;

  const labels = (issue.labels || []).map((x) => typeof x === 'string' ? x : x?.name).filter(Boolean);
  const lower = text.toLowerCase();
  const rewardUsd = parseReward(text);
  if (rewardUsd === null || rewardUsd < MIN_REWARD_USD) return null;

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
  if (/documentation|docs|typescript|javascript|node|react|api|bug|feature|column|field|test/i.test(text)) score += 12;
  if (/acceptance criteria|definition of done|requirements/i.test(text)) score += 8;
  if (/fill out.*form|join.*slack|kyc|identity verification|needs reproduction/i.test(text)) score -= 12;

  const ageDays = Math.max(0, (Date.now() - new Date(issue.updated_at).getTime()) / 86400000);
  score += Math.max(0, 10 - Math.floor(ageDays / 3));

  if (!issue.repository_url || !issue.html_url) return null;
  return {
    id: `github:${issue.id}`,
    source: 'github',
    title,
    url: issue.html_url,
    repositoryApiUrl: issue.repository_url,
    rewardUsd,
    score,
    labels,
    updatedAt: issue.updated_at,
    summary: clean(body, 520),
    state: 'candidate',
  };
}

async function search(query) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'autonomous-ai-job-scout',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
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
const since = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
const queries = [
  `is:issue is:open bounty in:title,body updated:>=${since}`,
  `is:issue is:open reward in:title,body updated:>=${since}`,
  `is:issue is:open USDT in:title,body updated:>=${since}`,
  `is:issue is:open paid in:title,body label:"help wanted" updated:>=${since}`,
];

try {
  const pages = await Promise.all(queries.map(search));
  const seen = new Set();
  const candidates = [];
  for (const issue of pages.flat()) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    if (issue.pull_request) continue;
    const candidate = scoreIssue(issue);
    if (!candidate) continue;
    if (candidate.score < 42) continue;
    candidates.push(candidate);
  }

  candidates.sort((a, b) => (b.score - a.score) || ((b.rewardUsd || 0) - (a.rewardUsd || 0)));
  jobs.version = 3;
  jobs.updatedAt = new Date().toISOString();
  jobs.status = candidates.length ? 'candidates' : 'idle';
  jobs.source = 'github-public-issues';
  jobs.opportunities = candidates.slice(0, MAX_RESULTS);
  jobs.selected = null;
  jobs.selection = null;
  jobs.lastError = null;
} catch (error) {
  jobs.updatedAt = new Date().toISOString();
  jobs.status = 'degraded';
  jobs.lastError = clean(error instanceof Error ? error.message : String(error), 300);
}

await fs.writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
console.log(`Autonomous job scout: ${jobs.status}; opportunities=${jobs.opportunities?.length || 0}`);

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const JOBS_PATH = path.join(process.cwd(), 'autonomous-ai/jobs.json');
const WORK_ROOT = path.join(process.cwd(), 'autonomous-ai/work');
const FREE_URL = 'https://opencode.ai/inference/openai/v1/chat/completions';
const FREE_MODEL = 'mimo-v2.5-free';
const MAX_STEPS = 10;
const MAX_FILE_BYTES = 50000;
const BLOCKED_PREFIXES = ['.git/', '.github/', 'node_modules/', 'dist/', 'build/', '.next/', 'target/'];

function clean(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeRelative(input = '') {
  const normalized = path.posix.normalize(String(input).replace(/\\/g, '/')).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.isAbsolute(normalized)) throw new Error('Unsafe path.');
  if (BLOCKED_PREFIXES.some((p) => normalized === p.slice(0, -1) || normalized.startsWith(p))) throw new Error('Path is protected.');
  return normalized;
}

function parseIssueUrl(url = '') {
  const match = String(url).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
  if (!match) throw new Error('Selected job is not a supported GitHub issue.');
  return { owner: match[1], repo: match[2], issue: Number(match[3]) };
}

function parseJson(content) {
  const cleaned = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function callModel(messages, maxTokens = 1800, temperature = 0.1) {
  const response = await fetch(FREE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: FREE_MODEL, messages, stream: false, temperature, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(50000),
  });
  const body = await response.json().catch(() => ({}));
  const content = body?.choices?.[0]?.message?.content;
  if (!response.ok || typeof content !== 'string' || !content.trim()) {
    throw new Error(body?.error?.message || `Worker model failed (${response.status})`);
  }
  return content;
}

async function listTree(root, rel = '', depth = 0, out = []) {
  if (depth > 4 || out.length >= 350) return out;
  const dir = rel ? path.join(root, rel) : root;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= 350) break;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (BLOCKED_PREFIXES.some((p) => child === p.slice(0, -1) || child.startsWith(p))) continue;
    out.push(entry.isDirectory() ? `${child}/` : child);
    if (entry.isDirectory()) await listTree(root, child, depth + 1, out);
  }
  return out;
}

async function readFileTool(root, rel) {
  const safe = safeRelative(rel);
  const file = path.join(root, safe);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('Not a file.');
  if (stat.size > MAX_FILE_BYTES) throw new Error(`File too large (${stat.size} bytes).`);
  return (await fs.readFile(file, 'utf8')).slice(0, MAX_FILE_BYTES);
}

async function listTool(root, rel = '') {
  const raw = String(rel || '').trim();
  const safe = !raw || raw === '.' || raw === './' ? '' : safeRelative(raw);
  const dir = safe ? path.join(root, safe) : root;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((x) => !BLOCKED_PREFIXES.some((p) => `${safe ? `${safe}/` : ''}${x.name}`.startsWith(p))).slice(0, 120).map((x) => `${x.isDirectory() ? 'dir' : 'file'} ${x.name}`).join('\n');
}

async function searchTool(root, query) {
  const needle = String(query || '').toLowerCase().trim();
  if (!needle || needle.length > 120) throw new Error('Invalid search query.');
  const files = (await listTree(root)).filter((x) => !x.endsWith('/')).slice(0, 300);
  const matches = [];
  for (const rel of files) {
    if (matches.length >= 40) break;
    const full = path.join(root, rel);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || stat.size > 120000) continue;
    const text = await fs.readFile(full, 'utf8').catch(() => null);
    if (typeof text !== 'string') continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && matches.length < 40; i += 1) {
      if (lines[i].toLowerCase().includes(needle)) matches.push(`${rel}:${i + 1}: ${lines[i].slice(0, 260)}`);
    }
  }
  return matches.join('\n') || 'No matches.';
}

async function writeFileTool(root, rel, content) {
  const safe = safeRelative(rel);
  if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(safe)) throw new Error('Lockfile edits are not allowed in autonomous preparation.');
  const text = String(content ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new Error('Generated file exceeds size limit.');
  const file = path.join(root, safe);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  return `Wrote ${safe} (${Buffer.byteLength(text)} bytes).`;
}

async function fetchIssue(owner, repo, number) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'autonomous-ai-worker' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`, { headers, signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || `Issue fetch failed (${response.status})`);
  return { title: clean(body.title, 300), body: String(body.body || '').slice(0, 12000), labels: (body.labels || []).map((x) => x?.name).filter(Boolean) };
}

async function syntaxChecks(repoDir) {
  const { stdout } = await exec('git', ['diff', '--name-only'], { cwd: repoDir, timeout: 10000 });
  const files = stdout.split('\n').map((x) => x.trim()).filter(Boolean);
  const results = [];
  await exec('git', ['diff', '--check'], { cwd: repoDir, timeout: 10000 });
  results.push('git diff --check: pass');
  for (const rel of files.filter((x) => /\.(?:js|mjs|cjs)$/i.test(x)).slice(0, 10)) {
    try {
      await exec('node', ['--check', rel], { cwd: repoDir, timeout: 10000 });
      results.push(`node --check ${rel}: pass`);
    } catch (error) {
      results.push(`node --check ${rel}: fail ${clean(error?.stderr || error?.message, 220)}`);
    }
  }
  for (const rel of files.filter((x) => /\.json$/i.test(x)).slice(0, 10)) {
    try {
      JSON.parse(await fs.readFile(path.join(repoDir, rel), 'utf8'));
      results.push(`json ${rel}: pass`);
    } catch (error) {
      results.push(`json ${rel}: fail ${clean(error?.message, 220)}`);
    }
  }
  return results;
}

const jobs = JSON.parse(await fs.readFile(JOBS_PATH, 'utf8'));
const selected = jobs.selected;
if (!selected) {
  console.log('Autonomous worker: no selected job');
  process.exit(0);
}

if (jobs.active?.id === selected.id && ['prepared', 'submission_ready'].includes(jobs.active?.stage)) {
  console.log('Autonomous worker: selected job already prepared');
  process.exit(0);
}

const ref = parseIssueUrl(selected.url);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autonomous-ai-job-'));
const repoDir = path.join(temp, 'repo');
const workId = `${ref.owner}--${ref.repo}--${ref.issue}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
const workDir = path.join(WORK_ROOT, workId);

try {
  await exec('git', ['clone', '--depth', '1', '--filter=blob:none', `https://github.com/${ref.owner}/${ref.repo}.git`, repoDir], { timeout: 60000, maxBuffer: 1024 * 1024 });
  const issue = await fetchIssue(ref.owner, ref.repo, ref.issue);
  const tree = await listTree(repoDir);
  const initialContext = {
    job: { id: selected.id, title: selected.title, rewardUsd: selected.rewardUsd, url: selected.url },
    issue,
    repository: `${ref.owner}/${ref.repo}`,
    tree: tree.slice(0, 300),
  };

  const system = `You are WORKER, an autonomous software contractor preparing a patch for one public GitHub issue. Do not reveal hidden chain-of-thought. Work through explicit tool actions only.\n\nYou are in an isolated clone and may use only these JSON actions:\n{"action":"list","path":"relative/dir"}\n{"action":"read","path":"relative/file"}\n{"action":"search","query":"text"}\n{"action":"write","path":"relative/file","content":"complete file content"}\n{"action":"finish","summary":"short public delivery summary"}\n\nRules:\n- Return exactly one JSON action each turn and nothing else.\n- Read relevant code before editing.\n- Make the smallest change that satisfies the actual issue.\n- Do not edit .github, .git, generated build directories, dependency lockfiles, secrets, licenses, or unrelated files.\n- Do not add network callbacks, telemetry, credentials, payment redirects, or unrelated dependencies.\n- Do not weaken security or tests.\n- You cannot run arbitrary repository code. Static checks happen after you finish.\n- For the repository root, use {"action":"list","path":"."}.\n- If a tool returns an error, correct the action and continue instead of abandoning the job.\n- If the issue cannot be responsibly implemented with the available context, finish with a summary explaining that rather than fabricating work.`;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `Begin this paid task from measured repository context:\n${JSON.stringify(initialContext)}` },
  ];
  let deliverySummary = '';

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const content = await callModel(messages, 2200, 0.1);
    const action = parseJson(content);
    if (!action?.action) throw new Error('Worker returned an invalid tool action.');
    messages.push({ role: 'assistant', content: JSON.stringify(action) });

    if (action.action === 'finish') {
      deliverySummary = clean(action.summary, 600);
      break;
    }

    let result;
    try {
      if (action.action === 'list') result = await listTool(repoDir, action.path || '');
      else if (action.action === 'read') result = await readFileTool(repoDir, action.path);
      else if (action.action === 'search') result = await searchTool(repoDir, action.query);
      else if (action.action === 'write') result = await writeFileTool(repoDir, action.path, action.content);
      else throw new Error(`Unsupported worker action: ${action.action}`);
    } catch (toolError) {
      result = `TOOL ERROR: ${clean(toolError instanceof Error ? toolError.message : String(toolError), 500)}. Use repository-relative paths only; use "." for the repository root.`;
    }

    messages.push({ role: 'user', content: `TOOL RESULT:\n${String(result).slice(0, 16000)}` });
  }

  const { stdout: patch } = await exec('git', ['diff', '--binary'], { cwd: repoDir, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  if (!patch.trim()) throw new Error('Worker produced no repository changes.');
  const checks = await syntaxChecks(repoDir);

  const qaContent = await callModel([
    { role: 'system', content: 'You are QA for an autonomous software contractor. Review the PUBLIC issue and patch only. Do not expose hidden chain-of-thought. Return JSON only: {"verdict":"pass"|"needs_work","summary":string,"risks":string}. Pass only if the patch plausibly addresses the issue without unrelated or dangerous changes.' },
    { role: 'user', content: JSON.stringify({ issue: initialContext.issue, patch: patch.slice(0, 18000), staticChecks: checks }) },
  ], 1300, 0.05);
  const qa = parseJson(qaContent) || { verdict: 'needs_work', summary: 'QA output was invalid.', risks: 'Automatic QA could not be parsed.' };

  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(path.join(workDir, 'patch.diff'), patch, 'utf8');
  const report = {
    version: 1,
    job: selected,
    repository: `${ref.owner}/${ref.repo}`,
    issue: ref.issue,
    preparedAt: new Date().toISOString(),
    deliverySummary,
    staticChecks: checks,
    qa: {
      verdict: qa.verdict === 'pass' ? 'pass' : 'needs_work',
      summary: clean(qa.summary, 600),
      risks: clean(qa.risks, 600),
    },
    patchPath: `autonomous-ai/work/${workId}/patch.diff`,
  };
  await fs.writeFile(path.join(workDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');

  jobs.active = {
    id: selected.id,
    title: selected.title,
    rewardUsd: selected.rewardUsd,
    url: selected.url,
    stage: report.qa.verdict === 'pass' ? 'prepared' : 'needs_work',
    workId,
    preparedAt: report.preparedAt,
    qa: report.qa,
    patchPath: report.patchPath,
  };
  jobs.status = report.qa.verdict === 'pass' ? 'work_prepared' : 'work_needs_improvement';
  jobs.lastError = null;
} catch (error) {
  jobs.active = {
    id: selected.id,
    title: selected.title,
    rewardUsd: selected.rewardUsd,
    url: selected.url,
    stage: 'failed',
    failedAt: new Date().toISOString(),
    error: clean(error instanceof Error ? error.message : String(error), 500),
  };
  jobs.status = 'worker_degraded';
  jobs.lastError = jobs.active.error;
} finally {
  jobs.updatedAt = new Date().toISOString();
  await fs.writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}

console.log(`Autonomous worker: ${jobs.status}; job=${selected.title}`);

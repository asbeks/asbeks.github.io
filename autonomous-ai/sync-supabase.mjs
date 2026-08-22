import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.join(process.cwd(), 'autonomous-ai');
const INGEST_URL = 'https://yefvzehrytkzcxvylvhz.supabase.co/functions/v1/autonomous-ingest';
const AUDIENCE = 'autonomous-ai-supabase';

async function readJson(name) {
  return JSON.parse(await fs.readFile(path.join(ROOT, name), 'utf8'));
}

async function getOidcToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) throw new Error('GitHub OIDC environment is unavailable. Ensure id-token: write permission is enabled.');
  const url = new URL(requestUrl);
  url.searchParams.set('audience', AUDIENCE);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${requestToken}` },
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.value) throw new Error(body?.message || `OIDC token request failed (${response.status})`);
  return body.value;
}

const [state, economy, jobs, token] = await Promise.all([
  readJson('state.json'),
  readJson('economy.json'),
  readJson('jobs.json'),
  getOidcToken(),
]);

const response = await fetch(INGEST_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ state, economy, jobs }),
  signal: AbortSignal.timeout(30000),
});

const result = await response.json().catch(() => ({}));
if (!response.ok || !result?.ok) {
  throw new Error(result?.error || `Supabase ingest failed (${response.status})`);
}

console.log(`Supabase synchronized: cycle=${result.cycle}, opportunities=${result.opportunities}, selected=${result.selectedJob || 'none'}, ledger=${result.ledgerEvents}`);

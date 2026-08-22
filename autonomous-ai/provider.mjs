const FREE_URL = 'https://opencode.ai/inference/openai/v1/chat/completions';
const ZEN_URL = 'https://opencode.ai/zen/v1/chat/completions';
const FREE_MODELS = [
  'mimo-v2.5-free',
  'deepseek-v4-flash-free',
  'hy3-free',
  'nemotron-3.5-lightning-free',
  'nemotron-3-ultra-free',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function compactMessage(value, max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export class ProviderUnavailableError extends Error {
  constructor(message, failures = []) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.retryable = true;
    this.retryAfterSeconds = 300;
    this.failures = failures;
  }
}

export function isProviderUnavailableError(error) {
  return Boolean(error?.retryable || error?.name === 'ProviderUnavailableError');
}

export async function callOpenCode(messages, options = {}) {
  const apiKey = process.env.OPENCODE_API_KEY || '';
  const url = apiKey ? ZEN_URL : FREE_URL;
  const mode = apiKey ? 'OpenCode Zen' : 'OpenCode Free';
  const models = Array.isArray(options.models) && options.models.length ? options.models : FREE_MODELS;
  const maxTokens = Number(options.maxTokens || 1800);
  const temperature = Number(options.temperature ?? 0.15);
  const timeoutMs = Number(options.timeoutMs || 50000);
  const failures = [];
  let attempt = 0;

  for (let round = 0; round < 2; round += 1) {
    for (const model of models) {
      attempt += 1;
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, messages, stream: false, temperature, max_tokens: maxTokens }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await response.json().catch(() => ({}));
        const content = body?.choices?.[0]?.message?.content;
        if (response.ok && typeof content === 'string' && content.trim()) {
          return { content, model, mode, attempts: attempt };
        }
        const message = compactMessage(body?.error?.message || body?.message || (response.ok ? 'empty visible output' : `HTTP ${response.status}`));
        failures.push({ model, status: response.status, message });
      } catch (error) {
        failures.push({ model, status: 0, message: compactMessage(error instanceof Error ? error.message : String(error)) });
      }
      await sleep(650);
    }
    if (round === 0) await sleep(6000);
  }

  const rateLimited = failures.some((x) => x.status === 429 || /rate limit|too many requests/i.test(x.message));
  const summary = rateLimited
    ? 'All available OpenCode free models are temporarily rate-limited.'
    : 'All available OpenCode free models are temporarily unavailable.';
  throw new ProviderUnavailableError(summary, failures.slice(-10));
}

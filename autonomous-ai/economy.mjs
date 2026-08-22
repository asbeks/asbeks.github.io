import fs from 'node:fs/promises';
import path from 'node:path';

const ECONOMY_PATH = path.join(process.cwd(), 'autonomous-ai/economy.json');
const TON_API = 'https://toncenter.com/api/v3';
const TRON_API = 'https://api.trongrid.io';
const TON_USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const TRON_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const SUPABASE_URL = 'https://yefvzehrytkzcxvylvhz.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_SsKiMmuVhu0-rQkOZkQ0aw_TEJcsZDU';

function units(value, decimals = 6) {
  try { return Number(BigInt(String(value || '0'))) / 10 ** decimals; } catch { return 0; }
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers, cache: 'no-store', signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}`);
  return body;
}

async function loadEconomy() {
  return JSON.parse(await fs.readFile(ECONOMY_PATH, 'utf8'));
}

async function discoverBackendWallets() {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/observer_wallets?select=chain,public_address,active&active=eq.true`, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Accept: 'application/json',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Supabase wallet discovery returned ${response.status}`);
  const rows = await response.json().catch(() => []);
  const found = { ton: '', tron: '' };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.chain === 'ton' && typeof row.public_address === 'string') found.ton = row.public_address;
    if (row?.chain === 'tron' && typeof row.public_address === 'string') found.tron = row.public_address;
  }
  return found;
}

function seenIds(economy) {
  return new Set((economy.ledger || []).map((x) => x.id));
}

async function readTon(address, economy) {
  if (!address) return { balance: { TON: 0, USDT: 0 }, deposits: [], cursor: economy.cursors?.tonUtime || 0 };
  const headers = process.env.TONCENTER_API_KEY ? { 'X-API-Key': process.env.TONCENTER_API_KEY } : {};
  const account = await getJson(`${TON_API}/accountStates?address=${encodeURIComponent(address)}&include_boc=false`, headers);
  const TON = units(account.accounts?.[0]?.balance, 9);
  const jettonWallet = await getJson(`${TON_API}/jetton/wallets?owner_address=${encodeURIComponent(address)}&jetton_address=${encodeURIComponent(TON_USDT_MASTER)}&exclude_zero_balance=false&limit=1`, headers);
  const USDT = units(jettonWallet.jetton_wallets?.[0]?.balance, 6);

  const startUtime = Number(economy.cursors?.tonUtime || 0);
  const params = new URLSearchParams({ owner_address: address, jetton_master: TON_USDT_MASTER, direction: 'in', sort: 'asc', limit: '1000' });
  if (startUtime > 0) params.set('start_utime', String(startUtime + 1));
  const transfers = await getJson(`${TON_API}/jetton/transfers?${params.toString()}`, headers);
  const known = seenIds(economy);
  let cursor = startUtime;
  const deposits = [];
  for (const item of transfers.jetton_transfers || []) {
    cursor = Math.max(cursor, Number(item.transaction_now || 0));
    if (item.transaction_aborted) continue;
    const id = `ton:${item.transaction_hash || item.trace_id || item.transaction_lt}`;
    if (known.has(id)) continue;
    deposits.push({
      id,
      chain: 'ton',
      asset: 'USDT',
      type: 'revenue',
      amount: units(item.amount, 6),
      from: item.source || '',
      to: address,
      txHash: item.transaction_hash || '',
      timestamp: new Date(Number(item.transaction_now || 0) * 1000).toISOString(),
      confirmed: true,
    });
  }
  return { balance: { TON, USDT }, deposits, cursor };
}

async function readTron(address, economy) {
  if (!address) return { balance: { TRX: 0, USDT: 0 }, deposits: [], cursor: economy.cursors?.tronTimestamp || 0 };
  const headers = process.env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY } : {};
  const accountBody = await getJson(`${TRON_API}/v1/accounts/${encodeURIComponent(address)}`, headers);
  const account = accountBody.data?.[0] || {};
  const TRX = Number(account.balance || 0) / 1e6;
  let USDT = 0;
  for (const entry of account.trc20 || []) {
    if (entry && Object.prototype.hasOwnProperty.call(entry, TRON_USDT_CONTRACT)) {
      USDT = Number(entry[TRON_USDT_CONTRACT] || 0) / 1e6;
      break;
    }
  }

  const start = Number(economy.cursors?.tronTimestamp || 0);
  const params = new URLSearchParams({ only_confirmed: 'true', only_to: 'true', contract_address: TRON_USDT_CONTRACT, order_by: 'block_timestamp,asc', limit: '200' });
  if (start > 0) params.set('min_timestamp', String(start + 1));
  const txs = await getJson(`${TRON_API}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${params.toString()}`, headers);
  const known = seenIds(economy);
  let cursor = start;
  const deposits = [];
  for (const item of txs.data || []) {
    cursor = Math.max(cursor, Number(item.block_timestamp || 0));
    const id = `tron:${item.transaction_id || ''}`;
    if (!item.transaction_id || known.has(id)) continue;
    const decimals = Number(item.token_info?.decimals ?? 6);
    deposits.push({
      id,
      chain: 'tron',
      asset: 'USDT',
      type: 'revenue',
      amount: units(item.value, decimals),
      from: item.from || '',
      to: address,
      txHash: item.transaction_id,
      timestamp: new Date(Number(item.block_timestamp || 0)).toISOString(),
      confirmed: true,
    });
  }
  return { balance: { TRX, USDT }, deposits, cursor };
}

const economy = await loadEconomy();
let backendWallets = { ton: '', tron: '' };
try {
  backendWallets = await discoverBackendWallets();
} catch (error) {
  console.warn(`Wallet discovery warning: ${error instanceof Error ? error.message : String(error)}`);
}

const tonAddress = process.env.AI_TON_ADDRESS || economy.wallets?.tonAddress || backendWallets.ton || '';
const tronAddress = process.env.AI_TRON_ADDRESS || economy.wallets?.tronAddress || backendWallets.tron || '';

try {
  const [ton, tron] = await Promise.all([readTon(tonAddress, economy), readTron(tronAddress, economy)]);
  const added = [...ton.deposits, ...tron.deposits].filter((x) => x.amount > 0);
  economy.wallets = { tonAddress, tronAddress };
  economy.balances = {
    TON: ton.balance.TON,
    USDT_TON: ton.balance.USDT,
    TRX: tron.balance.TRX,
    USDT_TRON: tron.balance.USDT,
    totalUSDT: ton.balance.USDT + tron.balance.USDT,
  };
  economy.cursors = { tonUtime: ton.cursor, tronTimestamp: tron.cursor };
  economy.ledger = [...(economy.ledger || []), ...added].slice(-500);
  const revenueUSDT = economy.ledger.filter((x) => x.type === 'revenue' && x.asset === 'USDT').reduce((sum, x) => sum + Number(x.amount || 0), 0);
  const expensesUSDT = economy.ledger.filter((x) => x.type === 'expense' && x.asset === 'USDT').reduce((sum, x) => sum + Number(x.amount || 0), 0);
  economy.totals = { revenueUSDT, expensesUSDT, profitUSDT: revenueUSDT - expensesUSDT };
  economy.runwayDays = expensesUSDT > 0 ? Number((economy.balances.totalUSDT / Math.max(expensesUSDT / 30, 0.01)).toFixed(1)) : null;
  economy.status = tonAddress || tronAddress ? 'online' : 'unconfigured';
  economy.updatedAt = new Date().toISOString();
  economy.lastError = null;
  await fs.writeFile(ECONOMY_PATH, JSON.stringify(economy, null, 2) + '\n');
  console.log(`Economy updated: ${economy.balances.totalUSDT.toFixed(2)} USDT, +${added.length} deposits, wallets=${Number(Boolean(tonAddress)) + Number(Boolean(tronAddress))}/2`);
} catch (error) {
  economy.status = 'degraded';
  economy.updatedAt = new Date().toISOString();
  economy.lastError = error instanceof Error ? error.message : String(error);
  economy.wallets = { tonAddress, tronAddress };
  await fs.writeFile(ECONOMY_PATH, JSON.stringify(economy, null, 2) + '\n');
  console.error(`Economy degraded: ${economy.lastError}`);
}

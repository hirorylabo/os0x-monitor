import { pathToFileURL } from 'node:url';
import { loadEnvFile } from './_seed-utils.mjs';

const DEFAULT_ORIGIN = 'https://worldmonitor-ja-private.vercel.app';
const DEFAULT_QSTASH_URL = 'https://qstash.upstash.io';

export function qstashApiOrigin(value = DEFAULT_QSTASH_URL) {
  let url;
  try { url = new URL(value); } catch { throw new Error('QSTASH_URL must be an HTTPS Upstash QStash origin'); }
  if (url.protocol !== 'https:' || !/^qstash(?:-[a-z0-9]+)*\.upstash\.io$/.test(url.hostname)
    || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') {
    throw new Error('QSTASH_URL must be an HTTPS Upstash QStash origin');
  }
  return url.origin;
}

export function scheduleDestination(baseUrl = DEFAULT_ORIGIN) {
  const url = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('APP_BASE_URL must be an HTTPS origin');
  }
  return `${url.origin}/api/refresh-cache`;
}

export function selectSchedule(schedules, destination, scheduleId) {
  if (scheduleId) {
    const found = schedules.find((schedule) => schedule.scheduleId === scheduleId);
    if (!found) throw new Error('QSTASH_SCHEDULE_ID was not found; inspect --dry-run inventory');
    const existing = new URL(found.destination);
    const target = new URL(destination);
    if (existing.pathname !== '/api/refresh-cache' || existing.origin !== target.origin) {
      throw new Error('QSTASH_SCHEDULE_ID belongs to another destination');
    }
    return found;
  }
  const matches = schedules.filter((schedule) => schedule.destination === destination);
  if (matches.length > 1) throw new Error('Multiple exact schedules found; select QSTASH_SCHEDULE_ID');
  return matches[0];
}

export async function configureSchedule({ env = process.env, fetcher = globalThis.fetch, dryRun = true } = {}) {
  const destination = scheduleDestination(env.APP_BASE_URL);
  const apiOrigin = qstashApiOrigin(env.QSTASH_URL || undefined);
  if (!env.QSTASH_TOKEN) {
    if (dryRun) return { dryRun: true, destination, action: 'credentials_required', required: 'QSTASH_TOKEN', schedules: [] };
    throw new Error('QSTASH_TOKEN is required');
  }
  const request = async (path, init = {}) => {
    const response = await fetcher(`${apiOrigin}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${env.QSTASH_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-ja-scheduler/1.0', ...init.headers },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`QStash request failed (HTTP ${response.status})`);
    return response.json();
  };
  const inventory = await request('/v2/schedules');
  if (!Array.isArray(inventory)) throw new Error('Invalid QStash schedule inventory');
  const existing = selectSchedule(inventory, destination, env.QSTASH_SCHEDULE_ID);
  const scheduleId = existing?.scheduleId || 'worldmonitor-ja-private-cache-warm';
  if (!existing && inventory.some((schedule) => schedule.scheduleId === scheduleId)) {
    throw new Error('Default schedule ID belongs to another destination; select an exact existing schedule');
  }
  // Only safe fields: inventory headers and message bodies can contain secrets.
  const summary = {
    dryRun, destination, scheduleId, action: existing ? 'update' : 'create',
    schedules: inventory.map(({ scheduleId: id, destination: target }) => {
      const url = new URL(target);
      return { scheduleId: id, destination: `${url.origin}${url.pathname}` };
    }),
  };
  if (dryRun) return summary;
  if (!env.CACHE_WARM_SECRET) throw new Error('CACHE_WARM_SECRET is required');
  await request(`/v2/schedules/${destination}`, {
    method: 'POST',
    headers: {
      'Upstash-Cron': '*/30 * * * *',
      'Upstash-Schedule-Id': scheduleId,
      'Upstash-Method': 'POST',
      'Upstash-Retries': '2',
      'Upstash-Timeout': '60s',
      'Upstash-Forward-Authorization': `Bearer ${env.CACHE_WARM_SECRET}`,
    },
    body: JSON.stringify({ trigger: 'cache-warm-30m' }),
  });
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFile(import.meta.url);
  // Safe inventory is the default. Only --apply can update a schedule.
  configureSchedule({ dryRun: !process.argv.includes('--apply') })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

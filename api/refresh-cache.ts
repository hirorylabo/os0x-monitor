import { getCorsHeaders, isDisallowedOrigin } from '../server/cors';
import { authenticateInternalRequest } from '../server/_shared/internal-auth';
import { getCachedJson } from '../server/_shared/redis';
import { produceMarketSeed, produceCryptoSeed, produceEarthquakeSeed, producePredictionSeed, produceNaturalSeed, type WarmSeed } from '../server/_shared/ja-cache-warm';
import { issueSessionToken } from './_session.js';

export const config = { runtime: 'edge' };
const PRODUCTION_ORIGIN = 'https://worldmonitor-ja-private.vercel.app';
const WARM_READER_PATHS: Record<string, string> = {
  markets: '/api/market/v1/list-market-quotes',
  crypto: '/api/market/v1/list-crypto-quotes',
  earthquakes: '/api/seismology/v1/list-earthquakes',
  predictions: '/api/prediction/v1/list-prediction-markets',
  natural: '/api/natural/v1/list-natural-events',
  news: '/api/news/v1/list-feed-digest?variant=full&lang=ja',
};

function deploymentOrigins(): Set<string> {
  const allowed = new Set([PRODUCTION_ORIGIN]);
  for (const host of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) {
    if (host && /^[a-z0-9.-]+\.vercel\.app$/i.test(host)) allowed.add(`https://${host}`);
  }
  return allowed;
}

function assertWarmOrigin(origin: string): void {
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password) throw new Error('Cache warm origin must be an origin');
  if (process.env.NODE_ENV !== 'production' && ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1'].includes(url.hostname)) return;
  if (!deploymentOrigins().has(origin)) throw new Error('Cache warm origin is not this deployment');
}

export function resolveWarmOrigin(request: Request): string {
  const origin = new URL(process.env.APP_BASE_URL || request.url).origin;
  assertWarmOrigin(origin);
  return origin;
}

interface WarmReaderAuth { origin: string; sessionToken: string; protectionBypass?: string }

export async function issueWarmReaderAuth(base: string, request?: Request): Promise<WarmReaderAuth> {
  assertWarmOrigin(base);
  const { token } = await issueSessionToken();
  // An automation secret may only accompany a same-origin request back into
  // this exact preview/branch deployment, never the production alias or a
  // different allowed deployment. Do not copy browser cookies or Clerk auth.
  const isOwnPreview = process.env.VERCEL_ENV !== 'production' && base !== PRODUCTION_ORIGIN && deploymentOrigins().has(base)
    && request != null && new URL(request.url).origin === base;
  const protectionBypass = isOwnPreview
    ? process.env.VERCEL_AUTOMATION_BYPASS_SECRET || request.headers.get('x-vercel-protection-bypass') || undefined
    : undefined;
  return { origin: base, sessionToken: token, protectionBypass };
}

export function hasReaderData(name: string, data: any, now = Date.now()): boolean {
  if (name === 'markets' || name === 'crypto') return Array.isArray(data?.quotes) && data.quotes.some((quote: any) => Number.isFinite(quote.price) && quote.price > 0);
  if (name === 'earthquakes') return Array.isArray(data?.earthquakes) && data.earthquakes.some((quake: any) => quake.occurredAt > now - 7 * 86400_000 && quake.occurredAt <= now);
  if (name === 'predictions') return data?.dataAvailable === true && Array.isArray(data.markets) && data.markets.length > 0;
  if (name === 'natural') return data?.dataAvailable === true && Array.isArray(data.events) && data.events.length > 0;
  if (name === 'news') {
    const items = Object.values(data?.categories || {}).flatMap((bucket: any) => Array.isArray(bucket?.items) ? bucket.items : []);
    const generated = Number(data?.generatedAt);
    const generatedAt = Number.isFinite(generated) && generated > 0 ? generated : Date.parse(data?.generatedAt);
    return generatedAt > now - 60 * 60_000 && items.some((item: any) => item.publishedAt > now - 48 * 60 * 60_000 && item.publishedAt <= now + 5 * 60_000);
  }
  return false;
}

export async function verifyWarmReader(base: string, seed: Pick<WarmSeed, 'name' | 'readerPath'>, fetcher = globalThis.fetch, auth?: WarmReaderAuth) {
  assertWarmOrigin(base);
  if (WARM_READER_PATHS[seed.name] !== seed.readerPath) throw new Error('Reader path is not an approved warm target');
  const credentials = auth ?? await issueWarmReaderAuth(base);
  if (credentials.origin !== base) throw new Error('Reader credentials belong to another deployment');
  const headers: Record<string, string> = {
    Accept: 'application/json', 'User-Agent': 'worldmonitor-ja-cache-warm/1.0',
    Origin: base, 'X-WorldMonitor-Key': credentials.sessionToken,
  };
  if (credentials.protectionBypass) headers['x-vercel-protection-bypass'] = credentials.protectionBypass;
  const response = await fetcher(`${base}${seed.readerPath}`, {
    headers, signal: AbortSignal.timeout(18_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Typed reader HTTP ${response.status}`);
  const data = await response.json();
  if (!hasReaderData(seed.name, data)) throw new Error('Typed reader empty or stale');
}

export async function withinWarmDeadline<T>(work: Promise<T>, timeoutMs = 22_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Warm target deadline exceeded')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export default async function handler(request: Request): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...getCorsHeaders(request) };
  if (isDisallowedOrigin(request)) return new Response(null, { status: 403, headers });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'GET' && request.method !== 'POST') return new Response(null, { status: 405, headers });
  const unauthorized = await authenticateInternalRequest(request, 'CACHE_WARM_SECRET', headers);
  if (unauthorized) return unauthorized;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return new Response(JSON.stringify({ error: 'cache_not_configured' }), { status: 503, headers });
  }
  let base: string;
  try { base = resolveWarmOrigin(request); }
  catch { return new Response(JSON.stringify({ error: 'invalid_warm_origin' }), { status: 400, headers }); }
  if (new URL(request.url).searchParams.get('dryRun') === '1' || request.method === 'GET') {
    return new Response(JSON.stringify({ dryRun: true, baseUrl: base, producers: ['markets', 'crypto', 'earthquakes', 'predictions', 'natural'], reader: '/api/news/v1/list-feed-digest?variant=full&lang=ja' }), { headers });
  }
  let readerAuth: WarmReaderAuth;
  if (!process.env.WM_SESSION_SECRET || process.env.WM_SESSION_SECRET.length < 32) {
    return new Response(JSON.stringify({ error: 'reader_session_not_configured', required: 'WM_SESSION_SECRET' }), { status: 503, headers });
  }
  try { readerAuth = await issueWarmReaderAuth(base, request); }
  catch { return new Response(JSON.stringify({ error: 'reader_session_unavailable' }), { status: 503, headers }); }
  const producers = [produceMarketSeed, produceCryptoSeed, produceEarthquakeSeed, producePredictionSeed, produceNaturalSeed];
  const names = ['markets', 'crypto', 'earthquakes', 'predictions', 'natural'];
  const startedAt = Date.now();
  const results = await Promise.all([
    ...producers.map(async (producer, index) => {
      try {
        return await withinWarmDeadline((async () => {
          const seed = await producer();
          await verifyWarmReader(base, seed, globalThis.fetch, readerAuth);
          const heartbeat = await getCachedJson(seed.metaKey, true) as { fetchedAt?: number } | null;
          if (!heartbeat?.fetchedAt || Date.now() - heartbeat.fetchedAt > 35 * 60_000) throw new Error('Seed freshness verification failed');
          return { name: seed.name, ok: true, records: seed.records, fetchedAt: seed.fetchedAt };
        })());
      } catch (error) {
        return { name: names[index], ok: false, error: error instanceof Error ? error.message : 'Warm failed' };
      }
    }),
    (async () => {
      try {
        await verifyWarmReader(base, { name: 'news', readerPath: WARM_READER_PATHS.news! }, globalThis.fetch, readerAuth);
        return { name: 'news', ok: true };
      } catch (error) { return { name: 'news', ok: false, error: error instanceof Error ? error.message : 'Warm failed' }; }
    })(),
  ]);
  const failed = results.filter((result) => !result.ok).length;
  return new Response(JSON.stringify({ warmedAt: new Date().toISOString(), baseUrl: base, targets: results.length, ok: results.length - failed, failed, durationMs: Date.now() - startedAt, results }), { status: failed ? 503 : 200, headers });
}

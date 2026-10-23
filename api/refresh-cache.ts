import { getCorsHeaders, isDisallowedOrigin } from '../server/cors';
import { authenticateInternalRequest } from '../server/_shared/internal-auth';
import { getCachedJson } from '../server/_shared/redis';
import { produceMarketSeed, produceCryptoSeed, produceEarthquakeSeed, producePredictionSeed, produceNaturalSeed, type WarmSeed } from '../server/_shared/ja-cache-warm';

export const config = { runtime: 'edge' };
const PRODUCTION_ORIGIN = 'https://worldmonitor-ja-private.vercel.app';

export function resolveWarmOrigin(request: Request): string {
  const origin = new URL(process.env.APP_BASE_URL || request.url).origin;
  const allowed = new Set([PRODUCTION_ORIGIN]);
  for (const host of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) {
    if (host && /^[a-z0-9.-]+\.vercel\.app$/i.test(host)) allowed.add(`https://${host}`);
  }
  const url = new URL(origin);
  if (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname)) return origin;
  if (!allowed.has(origin)) throw new Error('Cache warm origin is not this deployment');
  return origin;
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

export async function verifyWarmReader(base: string, seed: Pick<WarmSeed, 'name' | 'readerPath'>, fetcher = globalThis.fetch) {
  const response = await fetcher(`${base}${seed.readerPath}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'worldmonitor-ja-cache-warm/1.0' }, signal: AbortSignal.timeout(18_000),
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
  const producers = [produceMarketSeed, produceCryptoSeed, produceEarthquakeSeed, producePredictionSeed, produceNaturalSeed];
  const names = ['markets', 'crypto', 'earthquakes', 'predictions', 'natural'];
  const startedAt = Date.now();
  const results = await Promise.all([
    ...producers.map(async (producer, index) => {
      try {
        return await withinWarmDeadline((async () => {
          const seed = await producer();
          await verifyWarmReader(base, seed);
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
        await verifyWarmReader(base, { name: 'news', readerPath: '/api/news/v1/list-feed-digest?variant=full&lang=ja' });
        return { name: 'news', ok: true };
      } catch (error) { return { name: 'news', ok: false, error: error instanceof Error ? error.message : 'Warm failed' }; }
    })(),
  ]);
  const failed = results.filter((result) => !result.ok).length;
  return new Response(JSON.stringify({ warmedAt: new Date().toISOString(), baseUrl: base, targets: results.length, ok: results.length - failed, failed, durationMs: Date.now() - startedAt, results }), { status: failed ? 503 : 200, headers });
}

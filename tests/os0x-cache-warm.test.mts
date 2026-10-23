import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getCachedJson, setCachedJson } from '../server/_shared/redis';
import { produceMarketSeed, produceCryptoSeed, produceEarthquakeSeed, producePredictionSeed, produceNaturalSeed, publishWarmSeed } from '../server/_shared/ja-cache-warm';
import { listMarketQuotes } from '../server/worldmonitor/market/v1/list-market-quotes';
import { listCryptoQuotes } from '../server/worldmonitor/market/v1/list-crypto-quotes';
import { listEarthquakes } from '../server/worldmonitor/seismology/v1/list-earthquakes';
import { listPredictionMarkets } from '../server/worldmonitor/prediction/v1/list-prediction-markets';
import { listNaturalEvents } from '../server/worldmonitor/natural/v1/list-natural-events';
import warmHandler, { hasReaderData, resolveWarmOrigin, verifyWarmReader } from '../api/refresh-cache';

const oldFetch = globalThis.fetch;
const oldEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = oldFetch;
  for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'FINNHUB_API_KEY', 'ALPHA_VANTAGE_API_KEY', 'LOCAL_API_MODE', 'APP_BASE_URL', 'VERCEL_URL', 'NODE_ENV', 'CACHE_WARM_SECRET']) {
    if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key];
  }
});

const ctx = () => ({ request: new Request('https://worldmonitor-ja-private.vercel.app/api/test'), pathParams: {}, headers: {} });

test('core producers publish envelopes+freshness and current typed RPC readers consume the fixtures', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  delete process.env.LOCAL_API_MODE;
  delete process.env.FINNHUB_API_KEY;
  delete process.env.ALPHA_VANTAGE_API_KEY;
  const stored = new Map<string, string>();
  const now = Date.now();
  const sourceFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('finance.yahoo.com')) return Response.json({ chart: { result: [{ meta: { regularMarketPrice: 100, chartPreviousClose: 95 }, indicators: { quote: [{ close: [90, 100] }] } }] } });
    if (url.includes('earthquake.usgs.gov')) return Response.json({ features: [{ id: 'quake-fixture', properties: { place: 'Japan', mag: 5.5, time: now - 60_000, url: 'https://earthquake.usgs.gov/fixture' }, geometry: { coordinates: [138, 36, 10] } }] });
    if (url.includes('gamma-api.polymarket.com')) return Response.json([{ id: 'policy-fixture', slug: 'policy-fixture', tags: [{ slug: 'geopolitics' }], markets: [{ question: 'Fixture policy vote?', outcomes: '["No","Yes"]', outcomePrices: '["0.4","0.6"]', volume: '10000' }] }]);
    if (url.includes('eonet.gsfc.nasa.gov')) return Response.json({ events: [{ id: 'event-fixture', title: 'Fixture volcano', categories: [{ id: 'volcanoes', title: 'Volcanoes' }], geometry: [{ type: 'Point', date: new Date(now - 60_000).toISOString(), coordinates: [138, 36] }], sources: [] }] });
    if (url.includes('coingecko.com')) return Response.json(['bitcoin', 'ethereum', 'solana'].map((id) => ({ id, current_price: 100, price_change_percentage_24h: 1, sparkline_in_7d: { price: [90, 100] } })));
    throw new Error(`Unmocked source ${new URL(url).hostname}`);
  };
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'redis.fixture.test') return sourceFetch(input, init);
    if (url.pathname.startsWith('/get/')) return Response.json({ result: stored.get(decodeURIComponent(url.pathname.slice(5))) ?? null });
    const command = JSON.parse(String(init?.body));
    assert.equal(command[0], 'SET');
    stored.set(command[1], command[2]);
    return Response.json({ result: 'OK' });
  }) as typeof fetch;
  const deps = { fetcher: sourceFetch, write: setCachedJson, read: getCachedJson, now: () => now };
  const produced = await Promise.all([produceMarketSeed(deps), produceCryptoSeed(deps), produceEarthquakeSeed(deps), producePredictionSeed(deps), produceNaturalSeed(deps)]);
  for (const seed of produced) {
    assert.ok(seed.records > 0);
    const raw = JSON.parse(stored.get(seed.key)!);
    assert.equal(raw._seed.fetchedAt, now);
    assert.equal(raw._seed.recordCount, seed.records);
    assert.equal(JSON.parse(stored.get(seed.metaKey)!).fetchedAt, now);
  }
  const stocks = await listMarketQuotes(ctx(), { symbols: [] });
  assert.ok(stocks.quotes.some((quote) => quote.symbol === '^N225'));
  assert.ok(stocks.quotes.some((quote) => quote.symbol === 'JPY=X'));
  assert.equal(hasReaderData('markets', stocks), true);
  const crypto = await listCryptoQuotes(ctx(), { ids: [] });
  assert.equal(crypto.quotes.length, 3);
  const quakes = await listEarthquakes(ctx(), { pageSize: 10, cursor: '' });
  assert.equal(quakes.earthquakes[0]?.id, 'quake-fixture');
  const predictions = await listPredictionMarkets(ctx(), { category: 'politics', query: '', pageSize: 50, cursor: '', source: 'MARKET_SOURCE_UNSPECIFIED' });
  assert.equal(predictions.markets[0]?.yesPrice, 0.6);
  const natural = await listNaturalEvents(ctx(), {});
  assert.equal(natural.events[0]?.title, 'Fixture volcano');
  assert.equal(natural.dataAvailable, true);
});

test('empty producer and failed publication do not stamp successful freshness', async () => {
  let writes = 0;
  const deps = { fetcher: oldFetch, now: Date.now, read: async () => null, write: async () => { writes++; return false; } };
  const descriptor = { name: 'x', key: 'fixture:x', metaKey: 'seed-meta:fixture:x', readerPath: '/api/test', records: 0 };
  await assert.rejects(publishWarmSeed(descriptor, {}, deps), /Empty producer/);
  assert.equal(writes, 0);
  await assert.rejects(publishWarmSeed({ ...descriptor, records: 1 }, {}, deps), /publication not confirmed/);
  assert.equal(writes, 1);
});

test('warm acceptance rejects HTTP 200 empty/stale payloads and hostile destination origins', async () => {
  await assert.rejects(verifyWarmReader('https://fixture.test', { name: 'markets', readerPath: '/api/test' }, async () => Response.json({ quotes: [] })), /empty or stale/);
  assert.equal(hasReaderData('news', { generatedAt: Date.now(), categories: { world: { items: [{ publishedAt: Date.now() - 72 * 3600_000 }] } } }), false);
  assert.equal(hasReaderData('news', { generatedAt: Date.now(), categories: { world: { items: [{ publishedAt: Date.now() - 60_000 }] } } }), true);
  process.env.NODE_ENV = 'production';
  delete process.env.APP_BASE_URL;
  assert.throws(() => resolveWarmOrigin(new Request('https://attacker.test/api/refresh-cache')), /not this deployment/);
  assert.equal(resolveWarmOrigin(new Request('https://worldmonitor-ja-private.vercel.app/api/refresh-cache')), 'https://worldmonitor-ja-private.vercel.app');
});


test('warm authentication and GET dry-run never perform producer work', async () => {
  process.env.CACHE_WARM_SECRET = 'fixture-warm-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  delete process.env.APP_BASE_URL;
  globalThis.fetch = async () => { throw new Error('dry-run must not fetch'); };
  const endpoint = 'https://worldmonitor-ja-private.vercel.app/api/refresh-cache';
  const denied = await warmHandler(new Request(endpoint, { method: 'POST' }));
  assert.equal(denied.status, 401);
  const dry = await warmHandler(new Request(endpoint, { headers: { Authorization: 'Bearer fixture-warm-secret' } }));
  assert.equal(dry.status, 200);
  const body = await dry.json();
  assert.equal(body.dryRun, true);
  assert.ok(body.producers.includes('earthquakes'));
  assert.ok(!JSON.stringify(body).includes('fixture-warm-secret'));
});

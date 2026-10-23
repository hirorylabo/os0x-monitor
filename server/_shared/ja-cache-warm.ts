import { getCachedJson, setCachedJson } from './redis';
import { buildEnvelope } from './seed-envelope';
import { resolveMarketQuoteProvider } from '../worldmonitor/market/v1/_quote-provider';
import { fetchCryptoMarkets, CRYPTO_META } from '../worldmonitor/market/v1/_shared';
import { buildBootstrapPools, fetchPolymarketEventsByTag } from './prediction-edge.generated.mjs';
import type { MarketQuote } from '../../src/generated/server/worldmonitor/market/v1/service_server';

const USER_AGENT = 'worldmonitor-ja-cache-warm/1.0';
const TTL_SECONDS = 6 * 60 * 60;
const STOCKS = [
  ['^GSPC', 'S&P 500'], ['^DJI', 'Dow Jones'], ['^IXIC', 'NASDAQ'],
  ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'NVIDIA'],
  ['^N225', '日経平均'], ['JPY=X', 'USD/JPY'], ['9984.T', 'ソフトバンクG'], ['7203.T', 'トヨタ'],
] as const;

export interface WarmSeed {
  name: string;
  key: string;
  metaKey: string;
  readerPath: string;
  records: number;
  available: boolean;
  fetchedAt: number;
}

export interface WarmDependencies {
  fetcher: typeof fetch;
  write: typeof setCachedJson;
  read: typeof getCachedJson;
  now: () => number;
}
const defaults: WarmDependencies = {
  fetcher: (...args) => globalThis.fetch(...args), write: setCachedJson, read: getCachedJson, now: Date.now,
};

async function json(url: string, deps: WarmDependencies): Promise<any> {
  const response = await deps.fetcher(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
  return response.json();
}

export async function publishWarmSeed(
  descriptor: Omit<WarmSeed, 'available' | 'fetchedAt'>,
  data: unknown,
  deps: WarmDependencies = defaults,
): Promise<WarmSeed> {
  if (descriptor.records <= 0) throw new Error('Empty producer result; last-good seed preserved');
  const fetchedAt = deps.now();
  const meta = { fetchedAt, recordCount: descriptor.records, sourceVersion: 'os0x-vercel-v1', schemaVersion: 1, state: 'OK' as const };
  const written = await deps.write(descriptor.key, buildEnvelope({ ...meta, data }), TTL_SECONDS, true);
  if (!written) throw new Error('Seed publication not confirmed');
  if (!await deps.write(descriptor.metaKey, meta, TTL_SECONDS + 86400, true)) throw new Error('Seed metadata publication not confirmed');
  // Do not call a HTTP 200 / Redis SET success a working data path: read through
  // the same unwrapped raw-key helper used by the typed RPC handlers.
  const [published, heartbeat] = await Promise.all([
    deps.read(descriptor.key, true), deps.read(descriptor.metaKey, true),
  ]);
  const verifiedMeta = heartbeat as { fetchedAt?: number; recordCount?: number } | null;
  if (!published || verifiedMeta?.fetchedAt !== fetchedAt || verifiedMeta?.recordCount !== descriptor.records) {
    throw new Error('Seed reader verification failed');
  }
  return { ...descriptor, available: true, fetchedAt };
}

export async function produceMarketSeed(deps: WarmDependencies = defaults): Promise<WarmSeed> {
  const provider = resolveMarketQuoteProvider();
  const quotes: MarketQuote[] = [];
  const missing: string[] = [];
  await Promise.all(STOCKS.map(async ([symbol, name], index) => {
    await new Promise((resolve) => setTimeout(resolve, index * 150));
    let quote: Pick<MarketQuote, 'price' | 'change' | 'sparkline'> | undefined;
    if (provider?.canQuote(symbol) && !symbol.endsWith('.T')) {
      const result = await provider.fetchQuote(symbol);
      if (result.status === 'ok') quote = result.quote;
    }
    // Existing Japanese/index/FX coverage has no Finnhub plan equivalent.
    // Use the same public Yahoo chart source as the upstream seed producer.
    if (!quote && (symbol.startsWith('^') || symbol.endsWith('=X') || symbol.endsWith('.T'))) {
      try {
        const chart = (await json(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`, deps))?.chart?.result?.[0];
        const price = chart?.meta?.regularMarketPrice;
        const previous = chart?.meta?.chartPreviousClose ?? chart?.meta?.previousClose;
        if (Number.isFinite(price) && price > 0 && Number.isFinite(previous) && previous > 0) {
          quote = { price, change: ((price - previous) / previous) * 100, sparkline: (chart?.indicators?.quote?.[0]?.close || []).filter((p: unknown) => typeof p === 'number' && Number.isFinite(p)) };
        }
      } catch { /* per-symbol failure must not discard working quotes */ }
    }
    if (quote) quotes.push({ symbol, name, display: symbol, ...quote });
    else missing.push(symbol);
  }));
  return publishWarmSeed({ name: 'markets', key: 'market:stocks-bootstrap:v1', metaKey: 'seed-meta:market:stocks', readerPath: '/api/market/v1/list-market-quotes', records: quotes.length }, {
    quotes, finnhubSkipped: !provider, skipReason: !provider ? 'Authorized equity provider not configured' : '',
    rateLimited: false, asOf: new Date(deps.now()).toISOString(),
    unavailableSymbols: missing.map((symbol) => ({ symbol, reason: 'MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_ERROR' })),
  }, deps);
}

export async function produceCryptoSeed(deps: WarmDependencies = defaults): Promise<WarmSeed> {
  // Reuse current provider fallback and metadata mapping; no additional API key.
  const items = await fetchCryptoMarkets(['bitcoin', 'ethereum', 'solana']);
  const quotes = items.filter((coin) => Number.isFinite(coin.current_price) && coin.current_price > 0).map((coin) => ({
    name: CRYPTO_META[coin.id]?.name || coin.id,
    symbol: CRYPTO_META[coin.id]?.symbol || coin.id.toUpperCase(), price: coin.current_price,
    change: coin.price_change_percentage_24h || 0, change7d: coin.price_change_percentage_7d_in_currency || 0,
    sparkline: coin.sparkline_in_7d?.price?.slice(-48) || [],
  }));
  return publishWarmSeed({ name: 'crypto', key: 'market:crypto:v1', metaKey: 'seed-meta:market:crypto', readerPath: '/api/market/v1/list-crypto-quotes', records: quotes.length }, { quotes }, deps);
}

export async function produceEarthquakeSeed(deps: WarmDependencies = defaults): Promise<WarmSeed> {
  const raw = await json('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson', deps);
  if (!Array.isArray(raw?.features)) throw new Error('Invalid USGS feed');
  const earthquakes = raw.features.flatMap((feature: any) => {
    const [longitude, latitude, depthKm] = feature?.geometry?.coordinates || [];
    const properties = feature?.properties;
    if (!feature?.id || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(properties?.time) || !Number.isFinite(properties?.mag)) return [];
    return [{ id: String(feature.id), place: String(properties.place || ''), magnitude: properties.mag,
      depthKm: depthKm || 0, location: { latitude, longitude }, occurredAt: properties.time,
      sourceUrl: String(properties.url || ''), source: 'usgs', category: 'earthquake' }];
  });
  return publishWarmSeed({ name: 'earthquakes', key: 'seismology:earthquakes:v1', metaKey: 'seed-meta:seismology:earthquakes', readerPath: '/api/seismology/v1/list-earthquakes', records: earthquakes.length }, { earthquakes }, deps);
}

export async function producePredictionSeed(deps: WarmDependencies = defaults): Promise<WarmSeed> {
  const pages = await Promise.all(['geopolitics', 'tech', 'finance'].map((tag) => fetchPolymarketEventsByTag(tag, {
    fetchFn: deps.fetcher, baseUrl: 'https://gamma-api.polymarket.com', userAgent: USER_AGENT,
    timeoutMs: 5_000, limit: 50, now: new Date(deps.now()),
  })));
  const markets = pages.flat().flatMap((event: any) => (event.markets || []).flatMap((market: any) => {
    try {
      const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
      const yesIndex = Array.isArray(outcomes) ? outcomes.findIndex((value: unknown) => typeof value === 'string' && value.toLowerCase() === 'yes') : -1;
      const yesPrice = Number(prices?.[yesIndex]);
      if (yesIndex < 0 || !market.question || !event.slug || !Number.isFinite(yesPrice) || yesPrice < 0 || yesPrice > 1) return [];
      return [{ title: String(market.question), yesPrice: yesPrice * 100, volume: Number(market.volume || 0),
        url: `https://polymarket.com/event/${encodeURIComponent(event.slug)}`,
        endDate: market.endDate || event.endDate || '', source: 'polymarket',
        tags: (event.tags || []).map((tag: any) => typeof tag === 'string' ? tag : tag.slug).filter(Boolean),
        eventKey: `polymarket:${event.id || event.slug}` }];
    } catch { return []; }
  }));
  // Share the current upstream category-integrity/scoring rules rather than
  // placing popular sports/finance questions in the geopolitical pool.
  const { pools } = buildBootstrapPools(markets, { now: deps.now(), limit: 25 });
  const records = Object.values(pools).reduce((count: number, pool) => count + (Array.isArray(pool) ? pool.length : 0), 0);
  return publishWarmSeed({ name: 'predictions', key: 'prediction:markets-bootstrap:v1', metaKey: 'seed-meta:prediction:markets', readerPath: '/api/prediction/v1/list-prediction-markets', records }, { ...pools, fetchedAt: deps.now() }, deps);
}

export async function produceNaturalSeed(deps: WarmDependencies = defaults): Promise<WarmSeed> {
  const raw = await json('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30&limit=100', deps);
  if (!Array.isArray(raw?.events)) throw new Error('Invalid EONET feed');
  const events = raw.events.flatMap((event: any) => {
    const geo = event?.geometry?.at(-1);
    const [lon, lat] = geo?.coordinates || [];
    const category = event.categories?.[0];
    const date = Date.parse(geo?.date);
    if (geo?.type !== 'Point' || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(date) || !category?.id) return [];
    return [{ id: event.id, title: event.title || '', description: event.description || '', category: category.id,
      categoryTitle: category.title || '', lat, lon, date, magnitude: geo.magnitudeValue || 0,
      magnitudeUnit: geo.magnitudeUnit || '', sourceUrl: event.sources?.[0]?.url || '', sourceName: 'EONET', closed: Boolean(event.closed),
      forecastTrack: [], conePolygon: [], pastTrack: [], canonicalAliases: [], agencyObservations: [] }];
  });
  return publishWarmSeed({ name: 'natural', key: 'natural:events:v1', metaKey: 'seed-meta:natural:events', readerPath: '/api/natural/v1/list-natural-events', records: events.length }, { events, fetchedAt: deps.now(), dataAvailable: true }, deps);
}

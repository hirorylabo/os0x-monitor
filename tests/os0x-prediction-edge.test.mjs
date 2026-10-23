import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { buildBootstrapPools as upstreamPools, poolIntegrityViolations } from '../scripts/_prediction-classify.mjs';
import { fetchPolymarketEventsByTag as upstreamFetch } from '../scripts/_prediction-upstream.mjs';
import { generatePredictionEdge } from '../scripts/generate-prediction-edge.mjs';
import { buildBootstrapPools, fetchPolymarketEventsByTag } from '../server/_shared/prediction-edge.generated.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/prediction-markets-raw-candidates.json', import.meta.url), 'utf8'));
const now = Date.parse('2026-08-04T00:00:00Z');

test('checked-in Edge artifacts exactly match a fresh upstream bundle', async () => {
  await generatePredictionEdge({ check: true });
});

test('Edge classifier preserves upstream ranking, category precedence, deduplication and disjoint pools', () => {
  const markets = [...fixture.markets, { ...fixture.markets[0], volume: 999_999_999 }];
  for (const limit of [5, 25]) {
    const result = buildBootstrapPools(markets, { now, limit });
    assert.deepEqual(result, upstreamPools(markets, { now, limit }));
    assert.ok(result.duplicatesDropped > 0);
    assert.deepEqual(poolIntegrityViolations(result.pools), []);
    const rows = Object.values(result.pools).flat();
    assert.equal(new Set(rows.map((row) => row.url)).size, rows.length);
    for (const pool of Object.values(result.pools)) assert.ok(pool.length > 0);
  }
});

test('bundled upstream HTTP helper preserves query, headers, response and errors', async () => {
  const calls = [];
  const events = [{ id: 'fixture', slug: 'event' }];
  const options = {
    fetchFn: async (url, init) => {
      calls.push({ url, headers: init.headers, signal: init.signal instanceof AbortSignal });
      return Response.json(events);
    },
    baseUrl: 'https://fixture.invalid/', userAgent: 'os0x-edge-test', timeoutMs: 1000,
    limit: 7, now: new Date(now),
  };
  assert.deepEqual(await fetchPolymarketEventsByTag('geopolitics', options), await upstreamFetch('geopolitics', options));
  assert.deepEqual(calls[0], calls[1]);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('tag_slug'), 'geopolitics');
  assert.equal(url.searchParams.get('limit'), '7');
  assert.equal(calls[0].headers['User-Agent'], 'os0x-edge-test');
  await assert.rejects(fetchPolymarketEventsByTag('tech', { ...options, fetchFn: async () => Response.json({}) }), /expected an array/);
  await assert.rejects(fetchPolymarketEventsByTag('tech', { ...options, fetchFn: async () => new Response('', { status: 503 }) }), /HTTP 503/);
});

test('Edge bundle has no import attributes or Node dependencies and runs with only web globals', async () => {
  const artifact = readFileSync(new URL('../server/_shared/prediction-edge.generated.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(artifact, /\b(?:with|assert)\s*\{\s*type\s*:/);
  assert.doesNotMatch(artifact, /^\s*import\s/m);
  const bundle = await build({
    stdin: { contents: artifact, loader: 'js' }, bundle: true, write: false,
    platform: 'browser', target: 'es2020', format: 'iife', globalName: 'PredictionEdge', logLevel: 'silent',
  });
  const context = { URLSearchParams, AbortSignal, Date };
  runInNewContext(bundle.outputFiles[0].text, context, { timeout: 1000 });
  const result = context.PredictionEdge.buildBootstrapPools(fixture.markets, { now });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), upstreamPools(fixture.markets, { now }));
  const events = await context.PredictionEdge.fetchPolymarketEventsByTag('tech', {
    fetchFn: async () => Response.json([{ id: 'edge' }]), baseUrl: 'https://fixture.invalid', userAgent: 'fixture',
  });
  assert.deepEqual(events, [{ id: 'edge' }]);
  assert.equal('process' in context, false);
  assert.equal('require' in context, false);
});

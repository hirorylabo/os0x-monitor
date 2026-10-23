import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { build } from 'esbuild';

const nativeFetch = globalThis.fetch;
const mocks = {
  './ml-worker': 'export const mlWorker = {isAvailable:false};',
  '@/services/rpc-client': 'export const getRpcBaseUrl=()=>""; export const getRpcErrorStatusCode=()=>0;',
  '@/config': 'export const SITE_VARIANT="full";',
  '@/config/beta': 'export const BETA_MODE=false;',
  './runtime-config': 'export const isFeatureAvailable=()=>true;',
  './analytics': 'export const trackLLMUsage=()=>{}; export const trackLLMFailure=()=>{};',
  './i18n': 'export const getCurrentLanguage=()=>globalThis.__os0xSummaryLocale;',
  './translation': 'export const translateTextToJapanese=async(text)=>text;',
  '@/utils': 'export const createCircuitBreaker=()=>({execute:async(work)=>work()});',
  '@/utils/summary-cache-key': 'export const buildSummaryCacheKey=async(...args)=>JSON.stringify(args);',
  '@/services/generated-rpc-clients': 'export class NewsServiceClient { async getSummarizeArticleCache(){globalThis.__os0xUpstreamReads++;return {};} async summarizeArticle(){throw new Error("Premium RPC must stay gated");} }',
  '@/services/premium-fetch': 'export const premiumFetch=()=>{throw new Error("Premium fetch must stay gated");};',
  '@/services/panel-gating': 'export const hasPremiumAccess=()=>false;',
};
const { outputFiles } = await build({ entryPoints: ['src/services/summarization.ts'], bundle: true, write: false, format: 'esm', platform: 'browser',
  plugins: [{ name: 'test-summary-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => args.path in mocks ? { path: args.path, namespace: 'fixture' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: mocks[args.path] }));
  } }],
});
let service; let calls;
beforeEach(async () => {
  calls = []; globalThis.__os0xSummaryLocale = 'ja'; globalThis.__os0xUpstreamReads = 0;
  service = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}#${Math.random()}`);
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return Response.json({ summary: '日本語の要約が表示されます。資料にある内容を保持しています。', provider: 'gemini', model: 'test-model', cached: false });
  };
});
after(() => { globalThis.fetch = nativeFetch; delete globalThis.__os0xSummaryLocale; delete globalThis.__os0xUpstreamReads; });
test('anonymous JA summary uses the owned route before any premium or upstream cache call', async () => {
  const result = await service.generateSummary(['a', 'b'], undefined, 'Japan', undefined, { bodies: ['body a', 'body b'] });
  assert.equal(result.provider, 'gemini');
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/groq-summarize');
  assert.deepEqual(calls[0].body.bodies, ['body a', 'body b']);
  assert.equal(globalThis.__os0xUpstreamReads, 0);
});
test('non-JA anonymous summaries retain the upstream entitlement gate', async () => {
  globalThis.__os0xSummaryLocale = 'en';
  assert.equal(await service.generateSummary(['a', 'b']), null);
  assert.equal(globalThis.__os0xUpstreamReads, 1); assert.equal(calls.length, 0);
});
test('skipCloudProviders prevents the owned JA route as well', async () => {
  assert.equal(await service.generateSummary(['a', 'b'], undefined, undefined, 'ja', { skipCloudProviders: true }), null);
  assert.equal(calls.length, 0); assert.equal(globalThis.__os0xUpstreamReads, 0);
});

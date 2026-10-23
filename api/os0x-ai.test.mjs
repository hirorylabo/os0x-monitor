import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';

const cache = new Map();
let budgetDenied = false;
let writes = 0;
let calls = [];
const nativeFetch = globalThis.fetch;
const originalEnv = { ...process.env };
mock.module('./_rate-limit.js', { namedExports: {
  checkRateLimit: async () => budgetDenied ? new Response('{"error":"budget"}', { status: 429 }) : null,
} });
mock.module('./_upstash-cache.js', { namedExports: {
  getCachedJson: async (key) => cache.get(key) ?? null,
  setCachedJson: async (key, value) => { await new Promise((resolve) => setTimeout(resolve, 5)); cache.set(key, value); writes += 1; },
} });
const { default: translate } = await import('./translate-ja.js');
const { default: summarize } = await import('./groq-summarize.js');
const { generateJapanese } = await import('./_os0x-llm.js');

function request(path, body, origin = 'http://localhost:3000') {
  return new Request(`http://localhost:3000/api/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
  });
}
function gemini(value) { return Response.json({ candidates: [{ content: { parts: [{ text: value }] } }] }); }
beforeEach(() => {
  cache.clear(); calls = []; writes = 0; budgetDenied = false;
  process.env.NODE_ENV = 'test';
  process.env.GEMINI_API_KEY = 'synthetic-gemini';
  process.env.GROQ_API_KEY = 'synthetic-groq';
  delete process.env.OS0X_GEMINI_MODEL; delete process.env.OS0X_GROQ_MODEL;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url: String(url), body });
    const texts = JSON.parse(body.contents[0].parts[0].text);
    return gemini(JSON.stringify(texts.map((text) => `${text}の日本語ニュース`)));
  };
});
after(() => {
  globalThis.fetch = nativeFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
test('12 headlines translate in one bounded call; duplicates and blank positions survive', async () => {
  const texts = ['First', 'First', '', '日本語です', ...Array.from({ length: 8 }, (_, i) => `Story${i}`)];
  const response = await translate(request('translate-ja', { texts }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.count, 12); assert.equal(body.translations.length, 12);
  assert.equal(body.translations[0], body.translations[1]);
  assert.equal(body.translations[2], ''); assert.equal(body.translations[3], '日本語です');
  assert.equal(calls.length, 1); assert.match(calls[0].url, /gemini-3.5-flash-lite/);
  assert.equal(writes, 9, 'writes are awaited before the response');
  await translate(request('translate-ja', { texts }));
  assert.equal(calls.length, 1, 'successful results are served from cache');
});
test('invalid batches are rejected instead of silently truncating input', async () => {
  for (const texts of [Array(13).fill('a'), ['a'.repeat(1601)], ['a', 7]]) {
    assert.equal((await translate(request('translate-ja', { texts }))).status, 400);
  }
  assert.equal(calls.length, 0);
});
test('provider failure advances once to current Groq model and retains input alignment', async () => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return String(url).includes('googleapis') ? new Response('', { status: 429 })
      : Response.json({ choices: [{ message: { content: '["翻訳された記事です"]' } }] });
  };
  const body = await (await translate(request('translate-ja', { text: 'Headline' }))).json();
  assert.deepEqual(body.translations, ['翻訳された記事です']);
  assert.deepEqual(body.providers, ['groq']); assert.equal(calls.length, 2);
  assert.equal(calls[1].body.model, 'openai/gpt-oss-20b');
  assert.equal(calls[1].body.include_reasoning, false);
});
test('malformed provider arrays never misattribute translations and are not cached', async () => {
  globalThis.fetch = async () => gemini('["one"]');
  const body = await (await translate(request('translate-ja', { texts: ['a', 'b'] }))).json();
  assert.deepEqual(body.translations, ['a', 'b']); assert.equal(writes, 0);
});
test('concurrent identical requests share one provider call', async () => {
  const [one, two] = await Promise.all([
    translate(request('translate-ja', { texts: ['a', 'b'] })),
    translate(request('translate-ja', { texts: ['b', 'a'] })),
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual((await one.json()).translations, ['aの日本語ニュース', 'bの日本語ニュース']);
  assert.deepEqual((await two.json()).translations, ['bの日本語ニュース', 'aの日本語ニュース']);
});
test('budgets and disallowed origins prevent provider spend', async () => {
  budgetDenied = true;
  assert.equal((await translate(request('translate-ja', { text: 'a' }))).status, 429);
  assert.equal((await summarize(request('groq-summarize', { headlines: ['a'] }))).status, 429);
  assert.equal((await translate(request('translate-ja', { text: 'a' }, 'https://evil.invalid'))).status, 403);
  assert.equal(calls.length, 0);
});
test('anonymous JA summary owns its request, caching and input context', async () => {
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return gemini('日本の市場では新たな動きがありました。関係者は今後の発表を確認しています。');
  };
  const payload = { headlines: ['a', 'b'], bodies: ['source a', 'source b'], geoContext: 'Japan' };
  const response = await summarize(request('groq-summarize', payload));
  assert.equal(response.status, 200); assert.equal((await response.json()).provider, 'gemini');
  assert.equal(writes, 1); assert.match(calls[0].contents[0].parts[0].text, /source a/);
  assert.equal((await (await summarize(request('groq-summarize', payload))).json()).cached, true);
  assert.equal(calls.length, 1);
});
test('provider timeout is aborted and the overall deadline ends the chain', async () => {
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const started = Date.now();
  const result = await generateJapanese({ request: request('translate-ja', {}), cors: {}, deadline: started + 1100,
    prompt: 'x', system: 'x', validate: (text) => text });
  assert.equal(result, null); assert.ok(Date.now() - started < 1500);
});

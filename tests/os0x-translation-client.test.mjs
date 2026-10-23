import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { build } from 'esbuild';
const nativeFetch = globalThis.fetch;
const localStorageBefore = globalThis.localStorage;
const { outputFiles } = await build({ entryPoints: ['src/services/translation.ts'], bundle: true, write: false, format: 'esm', platform: 'browser',
  plugins: [{ name: 'test-locale', setup(builder) {
    builder.onResolve({ filter: /^\.\/i18n$/ }, () => ({ path: 'test-i18n', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const getCurrentLanguage = () => globalThis.__os0xTestLanguage;' }));
  } }],
});
let service; let calls;
beforeEach(async () => {
  const store = new Map(); calls = [];
  globalThis.__os0xTestLanguage = 'ja';
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  service = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}#${Math.random()}`);
  globalThis.fetch = async (_url, init) => {
    const { texts } = JSON.parse(init.body); calls.push(texts);
    return Response.json({ translations: texts.map((text) => `${text}のニュース`) });
  };
});
after(() => { globalThis.fetch = nativeFetch; globalThis.localStorage = localStorageBefore; delete globalThis.__os0xTestLanguage; });
test('25 titles are chunked to 12/12/1 and every index survives', async () => {
  const input = Array.from({ length: 25 }, (_, i) => `Headline${i}`);
  const output = await service.translateBatchToJapanese(input);
  assert.deepEqual(calls.map((c) => c.length), [12, 12, 1]);
  assert.deepEqual(output, input.map((text) => `${text}のニュース`));
  assert.equal(service.getCachedJapaneseTranslation(input[24]), output[24]);
});
test('overlapping calls deduplicate and failures return unchanged originals', async () => {
  const [first, second] = await Promise.all([service.translateBatchToJapanese(['A', 'A']), service.translateBatchToJapanese(['A'])]);
  assert.equal(calls.length, 1); assert.deepEqual(first, ['Aのニュース', 'Aのニュース']); assert.deepEqual(second, ['Aのニュース']);
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.deepEqual(await service.translateBatchToJapanese(['Offline']), ['Offline']);
  assert.equal(service.getCachedJapaneseTranslation('Offline'), null);
});
test('non-Japanese locales and Japanese originals require no network', async () => {
  globalThis.__os0xTestLanguage = 'en';
  assert.deepEqual(await service.translateBatchToJapanese(['English']), ['English']);
  globalThis.__os0xTestLanguage = 'ja';
  assert.deepEqual(await service.translateBatchToJapanese(['日本語の記事', '']), ['日本語の記事', '']);
  assert.equal(calls.length, 0);
});

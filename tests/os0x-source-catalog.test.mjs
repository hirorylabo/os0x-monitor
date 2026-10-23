import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveSourceOrigin } from '../scripts/source-origin.mjs';

const entries = JSON.parse(readFileSync(new URL('../shared/source-attribution-manifest.json', import.meta.url), 'utf8')).entries;

test('model APIs, scheduler, first-party deployment and license docs are not ingested data providers', () => {
  for (const host of ['api.groq.com', 'generativelanguage.googleapis.com', 'qstash.upstash.io',
    'worldmonitor-ja-private.vercel.app', 'www.gnu.org']) {
    const entry = entries.find((item) => item.host === host);
    assert.ok(entry, `${host} must remain visible to source-attribution drift review`);
    assert.equal(entry.status, 'excluded', host);
  }
});

test('restored Japanese publishers have explicit origins and unknown origins remain strict', () => {
  for (const host of ['gigazine.net', 'news.web.nhk', 'sankei.com']) {
    assert.equal(resolveSourceOrigin({ provider: host, hosts: [host] }), 'JP', host);
  }
  assert.throws(() => resolveSourceOrigin({ provider: 'unreviewed-publisher.example', hosts: ['unreviewed-publisher.example'] }), /needs a catalog origin/);
});

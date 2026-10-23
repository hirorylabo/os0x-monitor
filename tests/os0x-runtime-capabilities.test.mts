import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createHostedCapabilityLoader } from '../src/services/hosted-capabilities.ts';
import { isAllowedOrigin } from '../server/cors.ts';
import { isDisallowedOrigin } from '../api/_cors.js';
import handler from '../api/runtime-capabilities.js';

const oldEnv = { ...process.env };
afterEach(() => { for (const key of ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'FRED_API_KEY', 'WS_RELAY_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; } });

test('CORS parity trusts this production deployment and only exact configured previews', () => {
  process.env.VERCEL_URL = 'worldmonitor-ja-private-ab123-proto0xs-projects.vercel.app';
  process.env.VERCEL_BRANCH_URL = 'worldmonitor-ja-private-git-update-proto0xs-projects.vercel.app';
  for (const host of ['worldmonitor-ja-private.vercel.app', process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) {
    const origin = `https://${host}`;
    assert.equal(isAllowedOrigin(origin), true);
    assert.equal(isDisallowedOrigin(new Request('https://example.test', { headers: { Origin: origin } })), false);
  }
  for (const origin of ['https://evil.vercel.app', 'https://worldmonitor-ja-private-evil.vercel.app', 'https://worldmonitor-ja-private.vercel.app.attacker.test', 'http://worldmonitor-ja-private.vercel.app']) {
    assert.equal(isAllowedOrigin(origin), false);
    assert.equal(isDisallowedOrigin(new Request('https://example.test', { headers: { Origin: origin } })), true);
  }
});

test('endpoint exposes only disabled capability booleans when configuration is absent', async () => {
  for (const key of ['FRED_API_KEY', 'WS_RELAY_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[key];
  const response = await handler(new Request('https://worldmonitor-ja-private.vercel.app/api/runtime-capabilities'));
  assert.deepEqual(await response.json(), { features: { economicFred: false, aisRelay: false } });
});

test('capability requests are deduplicated, strictly boolean and fail closed with cooldown', async () => {
  let calls = 0;
  let now = 0;
  const loader = createHostedCapabilityLoader(async () => { calls++; return Response.json({ features: { economicFred: true, aisRelay: 'secret-url' } }); }, () => now);
  await Promise.all([loader.ensure(), loader.ensure(), loader.ensure()]);
  assert.equal(calls, 1);
  assert.equal(loader.available('economicFred'), true);
  assert.equal(loader.available('aisRelay'), false);
  now = 301_000;
  await loader.ensure();
  assert.equal(calls, 2);
  let failures = 0;
  const failed = createHostedCapabilityLoader(async () => { failures++; throw new Error('offline'); }, () => now);
  await failed.ensure(); await failed.ensure();
  assert.equal(failures, 1);
  assert.equal(failed.available('aisRelay'), false);
});


test('configured capability facts never expose credentials or relay URLs', async () => {
  process.env.FRED_API_KEY = 'fixture-private-key';
  process.env.WS_RELAY_URL = 'wss://fixture-private-relay.example';
  const response = await handler(new Request('https://worldmonitor-ja-private.vercel.app/api/runtime-capabilities'));
  const body = await response.json();
  assert.deepEqual(body, { features: { economicFred: true, aisRelay: true } });
  assert.ok(!JSON.stringify(body).includes('fixture-private'));
});

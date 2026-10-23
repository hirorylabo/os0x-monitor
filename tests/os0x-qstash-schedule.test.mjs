import assert from 'node:assert/strict';
import test from 'node:test';
import { configureSchedule, qstashApiOrigin, scheduleDestination, selectSchedule } from '../scripts/setup-qstash-schedule.mjs';

const destination = 'https://worldmonitor-ja-private.vercel.app/api/refresh-cache';
const env = { QSTASH_TOKEN: 'fixture-token', CACHE_WARM_SECRET: 'fixture-secret' };

test('dry-run inventories safely and never mutates or prints forwarded secrets', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return Response.json([{ scheduleId: 'ours', destination }, { scheduleId: 'other', destination: 'https://other.example/api/refresh-cache?token=private-value', headers: { Authorization: 'private-value' } }]);
  };
  const result = await configureSchedule({ env, fetcher });
  assert.equal(result.action, 'update');
  assert.equal(result.scheduleId, 'ours');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://qstash.upstash.io/v2/schedules');
  assert.equal(calls[0].init.method, undefined);
  assert.ok(!JSON.stringify(result).includes('private-value'));
});

test('apply upserts the exact schedule without deleting any account schedules', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return Response.json(calls.length === 1 ? [{ scheduleId: 'ours', destination }] : { scheduleId: 'ours' });
  };
  await configureSchedule({ env, fetcher, dryRun: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers['Upstash-Schedule-Id'], 'ours');
  assert.equal(calls[1].init.headers['Upstash-Forward-Authorization'], 'Bearer fixture-secret');
  assert.equal(calls[1].init.headers['Upstash-Cron'], '*/30 * * * *');
  assert.deepEqual(JSON.parse(calls[1].init.body), { trigger: 'cache-warm-30m' });
  assert.ok(!calls.some(({ init }) => init.method === 'DELETE'));
});

test('unrelated IDs, ambiguous duplicates and unsafe origins fail before mutation', async () => {
  assert.throws(() => selectSchedule([{ scheduleId: 'x', destination: 'https://other.example/api/refresh-cache' }], destination, 'x'), /another destination/);
  assert.throws(() => selectSchedule([{ scheduleId: 'a', destination }, { scheduleId: 'b', destination }], destination), /Multiple/);
  assert.throws(() => scheduleDestination('http://example.com'), /HTTPS/);
  assert.throws(() => scheduleDestination('https://example.com/path'), /HTTPS/);
  let calls = 0;
  await assert.rejects(configureSchedule({ env, dryRun: false, fetcher: async () => { calls++; return Response.json([{ scheduleId: 'worldmonitor-ja-private-cache-warm', destination: 'https://other.example/job' }]); } }), /another destination/);
  assert.equal(calls, 1);
});

test('missing QStash token is a non-mutating dry-run result', async () => {
  const result = await configureSchedule({ env: {}, fetcher: async () => { throw new Error('must not fetch'); } });
  assert.equal(result.action, 'credentials_required');
});

test('regional QStash API applies only to the exact target while leaving a legacy schedule intact', async () => {
  const calls = [];
  const legacy = { scheduleId: 'legacy', destination: 'https://worldmonitor-ja.vercel.app/api/refresh-cache' };
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return Response.json(calls.length === 1 ? [legacy] : { scheduleId: 'worldmonitor-ja-private-cache-warm' });
  };
  const result = await configureSchedule({ env: { ...env, QSTASH_URL: 'https://qstash-eu-central-1.upstash.io' }, fetcher, dryRun: false });
  assert.equal(result.action, 'create');
  assert.equal(result.scheduleId, 'worldmonitor-ja-private-cache-warm');
  assert.equal(calls[0].url, 'https://qstash-eu-central-1.upstash.io/v2/schedules');
  assert.equal(calls[1].url, `https://qstash-eu-central-1.upstash.io/v2/schedules/${destination}`);
  assert.equal(calls[1].init.headers['Upstash-Schedule-Id'], result.scheduleId);
  assert.ok(calls.every(({ init }) => init.method !== 'DELETE' && init.redirect === 'error'));
  assert.deepEqual(result.schedules, [legacy]);
});

test('invalid QStash API origins are rejected before credentials can be sent', async () => {
  for (const QSTASH_URL of [
    'http://qstash.upstash.io',
    'https://qstash.upstash.io.evil.example',
    'https://redis.upstash.io',
    'https://qstash-eu-central-1.upstash.io@evil.example',
    'https://user:password@qstash.upstash.io',
    'https://qstash.upstash.io:8443',
    'https://qstash.upstash.io/v2',
    'https://qstash.upstash.io?token=value',
    'https://qstash.upstash.io#fragment',
    'not-a-url',
  ]) {
    await assert.rejects(configureSchedule({ env: { ...env, QSTASH_URL }, fetcher: async () => { throw new Error('must not fetch'); } }), /QSTASH_URL/);
  }
  assert.equal(qstashApiOrigin(), 'https://qstash.upstash.io');
  assert.equal(qstashApiOrigin('https://qstash-eu-central-1.upstash.io/'), 'https://qstash-eu-central-1.upstash.io');
});

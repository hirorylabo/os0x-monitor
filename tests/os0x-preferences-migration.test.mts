import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrateOs0xPreferences } from '../src/services/os0x-preferences-migration.ts';

function fixture(values: Record<string, string> = {}) {
  const data = new Map(Object.entries(values));
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

test('upgrading a real-shaped old profile preserves order, hidden panels, monitors, layers and source choices', () => {
  const values = {
    'worldmonitor-panels': JSON.stringify({ japan: { name: '日本', enabled: true }, cii: { enabled: false } }),
    'panel-order': '["japan","markets","live-news"]',
    'worldmonitor-panel-spans': '{"japan":2}',
    'worldmonitor-monitors': '[{"id":"saved","keywords":["CVE-2026-12345"]}]',
    'worldmonitor-layers': '{"military":true,"weather":false}',
    'worldmonitor-disabled-feeds': '["BBC World"]',
    'worldmonitor-map-theme': 'carto-light',
    'map-height': '480',
    'map-pinned': 'true',
  };
  const storage = fixture(values);
  assert.equal(migrateOs0xPreferences(storage), true);
  for (const [key, value] of Object.entries(values)) assert.equal(storage.getItem(key), value, key);
  assert.equal(storage.getItem('worldmonitor-layout-reset-v2.5'), 'done');
  assert.equal(storage.getItem('worldmonitor-sources-reduction-v3'), 'done');
  assert.equal(storage.getItem('worldmonitor-disabled-feeds-schema'), '1');
  assert.equal(storage.getItem('wm-map-provider'), 'openfreemap');
  assert.equal(storage.getItem('wm-map-theme:openfreemap'), 'positron');
});

test('all five old themes migrate and newer explicit map choices win', () => {
  const themes = [
    ['carto-dark', 'openfreemap', 'dark'], ['carto-light', 'openfreemap', 'positron'],
    ['carto-voyager', 'openfreemap', 'liberty'], ['ofm-bright', 'openfreemap', 'bright'],
    ['osm-standard', 'osm', 'standard'],
  ];
  for (const [theme, provider, nextTheme] of themes) {
    const storage = fixture({ 'worldmonitor-map-theme': JSON.stringify(theme) });
    assert.equal(migrateOs0xPreferences(storage), true);
    assert.equal(storage.getItem('wm-map-provider'), provider);
    assert.equal(storage.getItem(`wm-map-theme:${provider}`), nextTheme);
  }
  const storage = fixture({ 'worldmonitor-map-theme': 'carto-dark', 'wm-map-provider': 'carto', 'wm-map-theme:carto': 'voyager' });
  migrateOs0xPreferences(storage);
  assert.equal(storage.getItem('wm-map-provider'), 'carto');
  assert.equal(storage.getItem('wm-map-theme:carto'), 'voyager');
});

test('an intentionally disabled whole Japan category skips upstream cap-bug recovery', () => {
  const disabled = ['NHK', '共同通信', '朝日新聞', '産経ニュース', 'TBS NEWS DIG', '日経', 'ITmedia', 'GIGAZINE'];
  for (const schema of [undefined, '0', '1', '2']) {
    const storage = fixture({
      'worldmonitor-disabled-feeds': JSON.stringify(disabled),
      ...(schema === undefined ? {} : { 'worldmonitor-disabled-feeds-schema': schema }),
    });
    assert.equal(migrateOs0xPreferences(storage), true);
    assert.deepEqual(JSON.parse(storage.getItem('worldmonitor-disabled-feeds')!), disabled);
    assert.equal(storage.getItem('worldmonitor-disabled-feeds-schema'), schema === '2' ? '2' : '1');
  }
});

test('invalid denylists do not claim source-preference protection', () => {
  for (const raw of ['[null, 3]', '{"NHK":true}']) {
    const storage = fixture({ 'worldmonitor-disabled-feeds': raw });
    migrateOs0xPreferences(storage);
    assert.equal(storage.getItem('worldmonitor-disabled-feeds-schema'), null);
    assert.equal(storage.getItem('worldmonitor-sources-reduction-v3'), null);
  }
});

test('storage failure does not mark migration complete and the next boot can retry', () => {
  const storage = fixture({ 'worldmonitor-panels': '{"japan":{"enabled":true}}' });
  const fail = { getItem: storage.getItem, setItem: () => { throw new Error('quota'); } };
  assert.equal(migrateOs0xPreferences(fail), false);
  assert.equal(storage.getItem('os0x-preferences-v2.11.3'), null);
  assert.equal(migrateOs0xPreferences(storage), true);
});

test('fresh profiles keep latest defaults and migration is idempotent', () => {
  const storage = fixture();
  migrateOs0xPreferences(storage);
  assert.equal(storage.getItem('worldmonitor-layout-reset-v2.5'), null);
  assert.equal(storage.getItem('worldmonitor-sources-reduction-v3'), null);
  const before = [...storage.data];
  migrateOs0xPreferences(storage);
  assert.deepEqual([...storage.data], before);
});

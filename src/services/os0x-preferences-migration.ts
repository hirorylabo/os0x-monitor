/** Preserve the local v2.1.4 profile before upstream's historical reset migrations run. */
const MIGRATION_KEY = 'os0x-preferences-v2.11.3';
const LEGACY_THEMES: Record<string, [string, string]> = {
  // The os0x upgrade intentionally uses OpenFreeMap equivalents: public CARTO
  // styles now require an API key. Preserve light/dark intent without that dependency.
  'carto-dark': ['openfreemap', 'dark'],
  'carto-light': ['openfreemap', 'positron'],
  'carto-voyager': ['openfreemap', 'liberty'],
  'ofm-bright': ['openfreemap', 'bright'],
  'osm-standard': ['osm', 'standard'],
};

export function migrateOs0xPreferences(storage: Pick<Storage, 'getItem' | 'setItem'>): boolean {
  try {
    if (storage.getItem(MIGRATION_KEY)) return true;
    const rawPanels = storage.getItem('worldmonitor-panels');
    const panels: unknown = rawPanels ? JSON.parse(rawPanels) : null;
    if (panels && typeof panels === 'object' && !Array.isArray(panels)) {
      // The upstream v2.5 reset intentionally discarded orders and spans. Those
      // are current user choices in this fork, so mark that historical reset done.
      storage.setItem('worldmonitor-layout-reset-v2.5', 'done');
      storage.setItem('worldmonitor-panel-order-v1.9', 'done');
      storage.setItem('worldmonitor-tech-insights-top-v1', 'done');
      if (!storage.getItem('worldmonitor-variant')) storage.setItem('worldmonitor-variant', 'full');
    }
    const rawDisabled = storage.getItem('worldmonitor-disabled-feeds');
    const disabled: unknown = rawDisabled ? JSON.parse(rawDisabled) : null;
    if (Array.isArray(disabled) && disabled.every(name => typeof name === 'string')) {
      // Never replace a returning user's denylist with the new site's presets.
      storage.setItem('worldmonitor-sources-reduction-v3', 'done');
      storage.setItem('worldmonitor-frontline-europe-enable-v1', 'done');
      storage.setItem('worldmonitor-strategic-defaults-enable-v1', 'done');
      storage.setItem('worldmonitor-regional-feed-rollout-reconcile-v1', 'done');
      storage.setItem('worldmonitor-locale-boost-ja', 'done');
      // This fork never had upstream's alphabetical free-cap bug. Its v1
      // recovery would otherwise re-enable an intentionally disabled category.
      const schemaVersion = Number(storage.getItem('worldmonitor-disabled-feeds-schema'));
      if (!Number.isFinite(schemaVersion) || schemaVersion < 1) {
        storage.setItem('worldmonitor-disabled-feeds-schema', '1');
      }
    }
    const legacyTheme = storage.getItem('worldmonitor-map-theme');
    const theme = legacyTheme ? LEGACY_THEMES[legacyTheme.replace(/^"|"$/g, '')] : undefined;
    if (theme && !storage.getItem('wm-map-provider')) {
      storage.setItem(`wm-map-theme:${theme[0]}`, theme[1]);
      storage.setItem('wm-map-provider', theme[0]);
    }
    storage.setItem(MIGRATION_KEY, 'done');
    return true;
  } catch {
    // A blocked/full store must not prevent boot or claim a completed migration.
    return false;
  }
}

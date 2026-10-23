/** Public deployment identity; no credentials belong in this module. */
export const OS0X_SITE_NAME = 'os0x';
export const OS0X_SITE_ORIGIN = 'https://worldmonitor-ja-private.vercel.app';
export const OS0X_SOURCE_URL = 'https://github.com/hirorylabo/os0x-monitor';
export const OS0X_UPSTREAM_URL = 'https://github.com/koala73/worldmonitor';
export const OS0X_DEFAULT_LANGUAGE = 'ja';
export const OS0X_SELF_HOSTED = true;
export const OS0X_MAP_CENTER = { lat: 36.5, lon: 138 };
// Keep Japan centered even when the viewport extends across the antimeridian.
export const OS0X_MAP_RENDER_WORLD_COPIES = true;

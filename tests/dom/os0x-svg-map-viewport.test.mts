import { describe, expect, it, vi } from 'vitest';
import { MapComponent, type MapView } from '@/components/Map';
import { OS0X_MAP_CENTER } from '@/config/os0x';
import { SVG_MAP_VIEW_PRESETS } from '@/components/svg-map-viewport';

function createMap(width = 1280, height = 600) {
  const size = { width, height };
  const container = document.createElement('div');
  Object.defineProperties(container, {
    clientWidth: { get: () => size.width },
    clientHeight: { get: () => size.height },
  });
  const map = Object.assign(Object.create(MapComponent.prototype), {
    container,
    state: { view: 'global', zoom: 1.5, pan: { x: 0, y: 0 }, layers: {}, timeRange: '24h' },
    pendingGeographicCenter: null,
    panProjectionSize: null,
    destroyed: false,
    svg: null,
    ensureBaseLayerIntact: vi.fn(),
    render: vi.fn(),
  });
  // Exercise the production clamp together with centring without unrelated
  // overlay building or async data sources.
  map.applyTransform = () => map.clampPan(size.width, size.height);
  return { map, size };
}

function expectCenter(map: ReturnType<typeof createMap>['map'], center: { lat: number; lon: number }) {
  const actual = map.getCenter();
  expect(actual?.lat).toBeCloseTo(center.lat, 8);
  expect(actual?.lon).toBeCloseTo(center.lon, 8);
}

describe('os0x SVG fallback viewport', () => {
  it.each([[1440, 800], [390, 460], [900, 220]])('starts centred on Japan at %sx%s', (width, height) => {
    const { map } = createMap(width, height);
    expectCenter(map, OS0X_MAP_CENTER);
  });

  for (const view of Object.keys(SVG_MAP_VIEW_PRESETS) as MapView[]) {
    it.each([[1440, 800], [390, 460], [900, 220]])(`centres the ${view} preset independently of screen size (%sx%s)`, (width, height) => {
      const { map } = createMap(width, height);
      map.setView(view);
      expectCenter(map, SVG_MAP_VIEW_PRESETS[view]);
    });
  }

  it('keeps an explicit fallback/deep-link centre after a named preset and responsive resize', () => {
    const { map, size } = createMap();
    const explicit = { lat: -36.85, lon: 174.76 };
    map.setView('eu', 5);
    map.setCenter(explicit.lat, explicit.lon);
    expectCenter(map, explicit);
    size.width = 390;
    size.height = 460;
    map.renderWithSize(size.width, size.height);
    expectCenter(map, explicit);
    expect(map.state.zoom).toBe(5);
  });

  it('retains an explicit centre requested while the fallback is hidden', () => {
    const { map, size } = createMap(0, 0);
    map.setView('eu', 5);
    map.setCenter(40.71, -74);
    size.width = 390;
    size.height = 460;
    map.renderWithSize(size.width, size.height);
    expectCenter(map, { lat: 40.71, lon: -74 });
    expect(map.pendingGeographicCenter).toBeNull();
  });

  it('returns the Japan default after reset instead of the old Greenwich centre', () => {
    const { map } = createMap();
    map.resumeMobileLabelVisibility = vi.fn();
    map.setView('america');
    map.reset();
    expectCenter(map, OS0X_MAP_CENTER);
    expect(map.state.zoom).toBe(1);
  });
});

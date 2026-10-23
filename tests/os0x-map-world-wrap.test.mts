import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { culledIndices, type BoundedFeature } from '../src/components/map/conflict-zone-cull.ts';

interface Camera {
  center: { lng: number; lat: number };
  zoom: number;
  resize(width: number, height: number): void;
  getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
}
let createCamera: (width: number, zoom: number, worldCopies?: boolean, longitude?: number) => Camera;

before(async () => {
  // Exercise the installed MapLibre transform, not a camera mock. It applies
  // the same antimeridian constraint used by Map construction and resize().
  const result = await build({
    stdin: {
      contents: `
        import { MercatorTransform } from './node_modules/maplibre-gl/src/geo/projection/mercator_transform.ts';
        import { LngLat } from './node_modules/maplibre-gl/src/geo/lng_lat.ts';
        import { OS0X_MAP_CENTER, OS0X_MAP_RENDER_WORLD_COPIES } from './src/config/os0x.ts';
        export function createCamera(width, zoom, worldCopies = OS0X_MAP_RENDER_WORLD_COPIES, longitude = OS0X_MAP_CENTER.lon) {
          const camera = new MercatorTransform({ minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: worldCopies });
          camera.resize(width, 400);
          camera.setZoom(zoom);
          camera.setCenter(new LngLat(longitude, OS0X_MAP_CENTER.lat));
          return camera;
        }
      `,
      resolveDir: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
      sourcefile: 'os0x-real-maplibre-camera.ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    write: false,
  });
  ({ createCamera } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`));
});

function expectJapanCenter(camera: Camera): void {
  assert.ok(Math.abs(camera.center.lat - 36.5) < 1e-8);
  assert.ok(Math.abs(camera.center.lng - 138) < 1e-8);
}

describe('os0x Japanese map camera', () => {
  for (const width of [375, 862, 1440]) {
    it(`keeps Japan centered at global zoom 1.5 in a ${width}px viewport`, () => {
      const camera = createCamera(width, 1.5);
      expectJapanCenter(camera);
      assert.equal(camera.zoom, 1.5);
    });
  }

  it('preserves the Japanese center while desktop and mobile widths change', () => {
    const camera = createCamera(400, 2);
    for (const width of [862, 1440, 375]) {
      camera.resize(width, 400);
      expectJapanCenter(camera);
      assert.equal(camera.zoom, 2);
    }
  });

  it('reproduces the original observed westward clamp with world copies disabled', () => {
    const camera = createCamera(400, 2, false);
    expectJapanCenter(camera);
    camera.resize(862, 400);
    assert.ok(Math.abs(camera.center.lng - 104.23828125) < 1e-8);
  });

  it('retains both sides of an actual MapLibre dateline viewport when culling overlays', () => {
    const camera = createCamera(862, 4, undefined, 179);
    const bounds = camera.getBounds();
    assert.ok(bounds.getEast() > 180, 'the real camera must straddle the dateline');
    const features: BoundedFeature[] = [
      { bounds: [172, 30, 178, 40], feature: { type: 'Feature', properties: {}, geometry: null } },
      { bounds: [-178, 30, -172, 40], feature: { type: 'Feature', properties: {}, geometry: null } },
      { bounds: [0, 30, 5, 40], feature: { type: 'Feature', properties: {}, geometry: null } },
    ];
    assert.deepEqual(culledIndices(features, [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], 0), [0, 1]);
  });
});

import { geoEquirectangular, type GeoProjection } from 'd3';
import { OS0X_MAP_CENTER } from '@/config/os0x';
import type { MapView } from './Map';

export const SVG_MAP_VIEW_PRESETS: Record<MapView, { lat: number; lon: number; zoom: number }> = {
  global: { ...OS0X_MAP_CENTER, zoom: 1 },
  america: { lat: 38, lon: -95, zoom: 1.8 },
  mena: { lat: 28, lon: 45, zoom: 3.5 },
  eu: { lat: 50, lon: 15, zoom: 2.4 },
  asia: { lat: 35, lon: 105, zoom: 2 },
  latam: { lat: -15, lon: -60, zoom: 2 },
  africa: { lat: 5, lon: 20, zoom: 2.2 },
  oceania: { lat: -25, lon: 135, zoom: 2.2 },
};

export function createSvgMapProjection(width: number, height: number): GeoProjection {
  const latitudeRange = 128;
  const scale = Math.min(width / (2 * Math.PI), height / (latitudeRange * Math.PI / 180));
  // Rotate the longitude seam as well as the centre: Japan must not sit at
  // the edge of the fallback's single world copy on narrow viewports.
  return geoEquirectangular()
    .scale(scale)
    .rotate([-OS0X_MAP_CENTER.lon, 0])
    .center([0, OS0X_MAP_CENTER.lat])
    .translate([width / 2, height / 2]);
}

export function svgMapPanForCenter(width: number, height: number, lat: number, lon: number): { x: number; y: number } | null {
  if (width <= 0 || height <= 0 || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const point = createSvgMapProjection(width, height)([lon, lat]);
  return point ? { x: width / 2 - point[0], y: height / 2 - point[1] } : null;
}

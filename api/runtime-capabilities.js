import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { getCachedJson } from './_upstash-cache.js';

export const config = { runtime: 'edge' };

// Configuration presence and an existing seed are public capability facts.
// Never return key values, relay URLs, or Redis credentials to the browser.
export default async function handler(request) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300', ...getCorsHeaders(request) };
  if (isDisallowedOrigin(request)) return new Response(null, { status: 403, headers });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'GET') return new Response(null, { status: 405, headers });
  const fredSeed = process.env.FRED_API_KEY ? null : await getCachedJson('economic:fred:v1:WALCL:0');
  const fredData = fredSeed?._seed ? fredSeed.data : fredSeed;
  return new Response(JSON.stringify({
    features: {
      economicFred: Boolean(process.env.FRED_API_KEY || fredData?.series?.observations?.length),
      aisRelay: Boolean(process.env.WS_RELAY_URL),
    },
  }), { status: 200, headers });
}

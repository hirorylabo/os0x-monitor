// Bundle the canonical Node seeder algorithms for the older Vercel Edge parser.
// Keep all classification/scoring/HTTP behavior in the upstream source modules.
export { buildBootstrapPools } from '../../scripts/_prediction-classify.mjs';
export { fetchPolymarketEventsByTag } from '../../scripts/_prediction-upstream.mjs';

import type { Sector, Commodity, MarketSymbol } from '@/types';
import cryptoConfig from '../../shared/crypto.json';
import sectorConfig from '../../shared/sectors.json';
import commodityConfig from '../../shared/commodities.json';
import stocksConfig from '../../shared/stocks.json';

export const SECTORS: Sector[] = sectorConfig.sectors as Sector[];

export const COMMODITIES: Commodity[] = commodityConfig.commodities as Commodity[];

export interface CatalogSymbol extends MarketSymbol {
  region: string;
}

export const STOCK_CATALOG: CatalogSymbol[] = stocksConfig.symbols as CatalogSymbol[];

export const AUXILIARY_STOCK_CATALOG: CatalogSymbol[] = (
  (stocksConfig as { auxiliarySymbols?: CatalogSymbol[] }).auxiliarySymbols ?? []
) as CatalogSymbol[];

export const REGION_LABELS: Record<string, string> = stocksConfig.regions;

const CATALOG_BY_SYMBOL = new Map(STOCK_CATALOG.map((symbol) => [symbol.symbol, symbol]));

// Preserve the canonical current-main default order independently of catalog
// grouping/order. A missing default is a configuration error, not a silent drop.
const defaultSymbols = stocksConfig.defaultSymbols.map((symbol) => {
  const entry = CATALOG_BY_SYMBOL.get(symbol);
  if (!entry) throw new Error(`Default market symbol is missing from catalog: ${symbol}`);
  return entry;
});

const JAPANESE_MARKETS: MarketSymbol[] = [
  { symbol: '^N225', name: '日経平均', display: 'N225' },
  { symbol: 'JPY=X', name: 'USD/JPY', display: 'USDJPY' },
  { symbol: '9984.T', name: 'ソフトバンクG', display: '9984' },
  { symbol: '7203.T', name: 'トヨタ', display: '7203' },
];
const japaneseBuild = (() => {
  try { return (import.meta.env.VITE_LOCALE || 'en').toLowerCase().startsWith('ja'); }
  catch { return false; } // Node-side catalog consumers have no Vite environment.
})();
export const MARKET_SYMBOLS: MarketSymbol[] = japaneseBuild
  ? [...JAPANESE_MARKETS, ...defaultSymbols.filter(entry => !JAPANESE_MARKETS.some(jp => jp.symbol === entry.symbol))]
  : defaultSymbols;

export const CRYPTO_IDS = cryptoConfig.ids as readonly string[];
export const CRYPTO_MAP: Record<string, { name: string; symbol: string }> = cryptoConfig.meta;

import type { NewsItem } from '@/types';

export interface TrendKeyword {
  keyword: string;
  type: 'cve' | 'apt' | 'entity';
  count2h: number;
  baseline7d: number;
  burstScore: number;
  firstSeen: number;
  sources: string[];
}

const CVE_RE = /CVE-\d{4}-\d{4,}/g;
const APT_RE = /\b(APT-?\d+|Lazarus(?:\s+Group)?|Kimsuky|Cozy\s*Bear|Fancy\s*Bear|Sandworm|Turla|Equation\s*Group|DarkSide|REvil|LockBit|BlackCat|ALPHV|Volt\s*Typhoon|Salt\s*Typhoon|Charming\s*Kitten|Midnight\s*Blizzard|Star\s*Blizzard|Forest\s*Blizzard|Scattered\s*Spider)\b/gi;

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const BASELINE_STORAGE_KEY = 'wm-trend-baseline';
const BURST_THRESHOLD = 3;

interface BaselineEntry {
  counts: number[]; // per-2h-window counts (rolling 7d = 84 windows)
  lastWindow: number;
}

type BaselineStore = Record<string, BaselineEntry>;

function currentWindow(): number {
  return Math.floor(Date.now() / TWO_HOURS_MS);
}

function loadBaseline(): BaselineStore {
  try {
    const raw = localStorage.getItem(BASELINE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveBaseline(store: BaselineStore): void {
  // Prune entries older than 7 days (84 windows)
  const minWindow = currentWindow() - 84;
  const pruned: BaselineStore = {};
  for (const [k, v] of Object.entries(store)) {
    if (v.lastWindow >= minWindow) pruned[k] = v;
  }
  try {
    localStorage.setItem(BASELINE_STORAGE_KEY, JSON.stringify(pruned));
  } catch { /* quota exceeded - ignore */ }
}

function extractKeywordsFromText(text: string): Array<{ keyword: string; type: TrendKeyword['type'] }> {
  const results: Array<{ keyword: string; type: TrendKeyword['type'] }> = [];
  const seen = new Set<string>();

  // CVEs
  for (const match of text.matchAll(CVE_RE)) {
    const kw = match[0].toUpperCase();
    if (!seen.has(kw)) { results.push({ keyword: kw, type: 'cve' }); seen.add(kw); }
  }

  // APT groups
  for (const match of text.matchAll(APT_RE)) {
    const kw = match[0].replace(/\s+/g, ' ').trim();
    const normalized = kw.toLowerCase();
    if (!seen.has(normalized)) { results.push({ keyword: kw, type: 'apt' }); seen.add(normalized); }
  }

  return results;
}

export function detectTrendKeywords(headlines: NewsItem[]): TrendKeyword[] {
  const now = Date.now();
  const win = currentWindow();
  const baseline = loadBaseline();

  // Count keywords in recent headlines (2h window)
  const windowCounts = new Map<string, { type: TrendKeyword['type']; count: number; sources: Set<string>; firstSeen: number }>();

  for (const item of headlines) {
    const age = now - new Date(item.pubDate).getTime();
    if (age > TWO_HOURS_MS) continue;

    const text = item.title;
    const keywords = extractKeywordsFromText(text);

    for (const { keyword, type } of keywords) {
      const key = keyword.toLowerCase();
      const entry = windowCounts.get(key);
      if (entry) {
        entry.count++;
        entry.sources.add(item.source);
      } else {
        windowCounts.set(key, {
          type,
          count: 1,
          sources: new Set([item.source]),
          firstSeen: new Date(item.pubDate).getTime(),
        });
      }
    }
  }

  // Compute burst scores against 7d baseline
  const results: TrendKeyword[] = [];

  for (const [key, data] of windowCounts) {
    const entry = baseline[key];
    let avg7d = 0;

    if (entry && entry.counts.length > 0) {
      const maxWindows = Math.floor(SEVEN_DAYS_MS / TWO_HOURS_MS);
      const recentCounts = entry.counts.slice(-maxWindows);
      avg7d = recentCounts.reduce((a, b) => a + b, 0) / Math.max(recentCounts.length, 1);
    }

    const burstScore = data.count / Math.max(avg7d, 0.5);

    // Update baseline
    if (!baseline[key]) {
      baseline[key] = { counts: [data.count], lastWindow: win };
    } else {
      const gap = win - baseline[key].lastWindow;
      // Fill gaps with zeros
      for (let i = 1; i < gap && baseline[key].counts.length < 84; i++) {
        baseline[key].counts.push(0);
      }
      if (gap > 0) {
        baseline[key].counts.push(data.count);
        baseline[key].lastWindow = win;
      } else {
        // Same window - update last count
        baseline[key].counts[baseline[key].counts.length - 1] = data.count;
      }
      // Keep max 84 windows (7 days)
      if (baseline[key].counts.length > 84) {
        baseline[key].counts = baseline[key].counts.slice(-84);
      }
    }

    if (burstScore >= BURST_THRESHOLD || data.count >= 2) {
      results.push({
        keyword: data.type === 'cve' ? key.toUpperCase() : [...windowCounts.entries()].find(([k]) => k === key)?.[1].type === 'apt' ? key : key,
        type: data.type,
        count2h: data.count,
        baseline7d: Math.round(avg7d * 100) / 100,
        burstScore: Math.round(burstScore * 10) / 10,
        firstSeen: data.firstSeen,
        sources: [...data.sources],
      });
    }
  }

  saveBaseline(baseline);

  // Sort by burst score descending
  return results.sort((a, b) => b.burstScore - a.burstScore).slice(0, 10);
}

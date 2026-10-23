import { getCurrentLanguage } from './i18n';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'wm:ja-translation:v2:';
const MAX_BATCH_SIZE = 12;
const memoryCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string>>();
type CacheEntry = { source: string; translated: string; timestamp: number };

function isJapaneseText(text: string): boolean { return /[\u3040-\u30ff]/.test(text); }
function cacheKey(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash) + text.charCodeAt(i);
  return `${CACHE_PREFIX}${(hash >>> 0).toString(36)}`;
}

export function getCachedJapaneseTranslation(text: string): string | null {
  const key = cacheKey(text);
  let entry = memoryCache.get(key);
  if (!entry) {
    try { entry = JSON.parse(localStorage.getItem(key) || 'null') as CacheEntry | undefined; } catch { return null; }
  }
  if (!entry || entry.source !== text || typeof entry.translated !== 'string' || !entry.translated
    || !Number.isFinite(entry.timestamp) || Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
  memoryCache.set(key, entry);
  return entry.translated;
}

function storeTranslation(source: string, translated: string): void {
  const key = cacheKey(source);
  const entry = { source, translated, timestamp: Date.now() };
  if (memoryCache.size >= 1000) memoryCache.delete(memoryCache.keys().next().value ?? '');
  memoryCache.set(key, entry);
  try { localStorage.setItem(key, JSON.stringify(entry)); } catch { /* Storage is optional. */ }
}

export function isJapaneseLocale(): boolean { return getCurrentLanguage().split('-')[0] === 'ja'; }

async function translateChunk(texts: string[], deadline: number): Promise<string[]> {
  if (deadline <= Date.now()) return texts;
  try {
    const response = await fetch('/api/translate-ja', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(Math.max(1, Math.min(24_000, deadline - Date.now()))),
      body: JSON.stringify({ texts }),
    });
    if (!response.ok) return texts;
    const data = await response.json() as { translations?: unknown };
    if (!Array.isArray(data.translations) || data.translations.length !== texts.length) return texts;
    return texts.map((original, i) => {
      const translated: unknown = (data.translations as unknown[])[i];
      if (typeof translated !== 'string' || !translated.trim()) return original;
      if (translated !== original) storeTranslation(original, translated);
      return translated;
    });
  } catch { return texts; }
}

export async function translateBatchToJapanese(texts: string[]): Promise<string[]> {
  if (!isJapaneseLocale() || !texts.length) return texts;
  const pending: { text: string; resolve: (value: string) => void }[] = [];
  const promises = texts.map((text) => {
    if (!text.trim() || isJapaneseText(text)) return Promise.resolve(text);
    const cached = getCachedJapaneseTranslation(text);
    if (cached) return Promise.resolve(cached);
    const existing = inflight.get(text);
    if (existing) return existing;
    const promise = new Promise<string>((resolve) => { pending.push({ text, resolve }); });
    inflight.set(text, promise);
    return promise;
  });
  // Keep every position, including >12 inputs and duplicate titles. Two batch
  // requests run at once; each request translates its whole array in one call.
  const deadline = Date.now() + 48_000;
  let next = 0;
  await Promise.all([0, 1].map(async () => {
    while (next < pending.length) {
      const chunk = pending.slice(next, next += MAX_BATCH_SIZE);
      const translated = await translateChunk(chunk.map((entry) => entry.text), deadline);
      chunk.forEach((entry, i) => {
        inflight.delete(entry.text);
        entry.resolve(translated[i] ?? entry.text);
      });
    }
  }));
  return Promise.all(promises);
}

export async function translateTextToJapanese(text: string): Promise<string> {
  const [translated] = await translateBatchToJapanese([text]);
  return translated ?? text;
}

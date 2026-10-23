import type { NewsItem } from '@/types';
import { detectTrendKeywords } from '@/services/trend-keywords';

/** One global sample per completed news load, preserving the old 2h/7d baseline. */
export function updateOs0xTrends(news: NewsItem[]): void {
  const bar = document.getElementById('trendBar');
  if (!bar) return;
  const trends = detectTrendKeywords(news);
  bar.replaceChildren();
  bar.hidden = trends.length === 0;
  if (!trends.length) return;
  const label = document.createElement('span');
  label.className = 'trend-label';
  label.textContent = document.documentElement.lang.startsWith('ja') ? '急上昇' : 'Trending';
  bar.append(label);
  for (const trend of trends) {
    const badge = document.createElement('span');
    badge.className = `trend-badge trend-${trend.type}`;
    badge.title = `${trend.count2h} / 2h · 7d baseline ${trend.baseline7d} · ${trend.sources.join(', ')}`;
    badge.textContent = trend.keyword;
    const count = document.createElement('sup');
    count.textContent = String(trend.count2h);
    badge.append(count);
    bar.append(badge);
  }
}

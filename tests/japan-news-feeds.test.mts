import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';
import { VARIANT_FEEDS, isServerFeedReachableForLanguage } from '../server/worldmonitor/news/v1/_feeds.ts';
import { isAllowedDomain } from '../api/_rss-allowed-domain-match.js';
import apiAllowedDomains from '../api/_rss-allowed-domains.js';
import { declaredSourceTier, getSourceTier } from '../server/_shared/source-tiers.ts';
import { getSourceType, getSourcePropagandaRisk, hasReviewedPropagandaRisk } from '../shared/source-provenance.ts';
import { CONFIGURED_SOURCE_PROVENANCE_DECLARATIONS } from '../shared/source-provenance-declarations.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tempDir = join(repoRoot, 'tmp-japan-feed-test');
interface Feed { name: string; url: string; lang: string }
let feeds: {
  FULL_FEEDS: Record<string, Feed[]>;
  getLocaleBoostedSources(locale: string): Set<string>;
  SOURCE_REGION_MAP: Record<string, { feedKeys: string[] }>;
};

before(async () => { feeds = await bundleFeedsModule({ repoRoot, tempDir }); });
after(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('Japanese news sources', () => {
  it('preserves the baseline explicit tiers and types without inventing reviewed risk ratings', () => {
    // Exact values from the deployed d86702f source registry, before tier data
    // moved to canonical shared files. That revision had no explicit JA risk entries.
    const baseline = [
      ['NHK', 1, 'wire'], ['共同通信', 1, 'wire'],
      ['日経', 2, 'market'], ['朝日新聞', 2, 'mainstream'],
      ['産経ニュース', 2, 'mainstream'], ['TBS NEWS DIG', 2, 'mainstream'],
      ['ITmedia', 3, 'tech'], ['GIGAZINE', 3, 'tech'],
    ] as const;
    for (const [name, tier, type] of baseline) {
      assert.equal(getSourceTier(name), tier, name);
      assert.equal(declaredSourceTier(name), tier, name);
      assert.equal(getSourceType(name), type, name);
      assert.equal(getSourcePropagandaRisk(name).risk, 'unknown', name);
      assert.equal(hasReviewedPropagandaRisk(name), false, name);
      assert.deepEqual(CONFIGURED_SOURCE_PROVENANCE_DECLARATIONS[name], { risk: 'unknown', type: 'reviewed' }, name);
    }
    assert.equal(readFileSync(join(repoRoot, 'shared/source-tiers.json'), 'utf8'),
      readFileSync(join(repoRoot, 'scripts/shared/source-tiers.json'), 'utf8'));
  });

  it('retains all eight publishers in matching client and server categories', () => {
    const expected = ['NHK', '共同通信', '朝日新聞', '産経ニュース', 'TBS NEWS DIG', '日経', 'ITmedia', 'GIGAZINE'];
    const client = feeds.FULL_FEEDS.japan!;
    const server = VARIANT_FEEDS.full!.japan!;
    assert.deepEqual(client.map(feed => feed.name), expected);
    assert.deepEqual(server.map(feed => feed.name), expected);
    for (const [index, feed] of client.entries()) {
      assert.equal(feed.lang, 'ja');
      assert.equal(feeds.getLocaleBoostedSources('ja-JP').has(feed.name), true);
      assert.equal(isServerFeedReachableForLanguage(server[index]!, 'ja'), true);
      // The harness's rssProxyUrl is identity; normalize GN encoding before comparison.
      const left = new URL(feed.url);
      const right = new URL(server[index]!.url);
      assert.equal(left.origin + left.pathname, right.origin + right.pathname);
      assert.deepEqual([...left.searchParams.entries()].sort(), [...right.searchParams.entries()].sort());
      assert.equal(isAllowedDomain(left.hostname, apiAllowedDomains), true, left.hostname);
    }
    assert.deepEqual(feeds.SOURCE_REGION_MAP.japan!.feedKeys, ['japan']);
  });

  it('keeps every RSS allowlist mirror identical', () => {
    const canonical = JSON.parse(readFileSync(join(repoRoot, 'shared/rss-allowed-domains.json'), 'utf8'));
    const scripts = JSON.parse(readFileSync(join(repoRoot, 'scripts/shared/rss-allowed-domains.json'), 'utf8'));
    assert.deepEqual(apiAllowedDomains, canonical);
    assert.deepEqual(scripts, canonical);
    assert.equal(apiAllowedDomains.includes('news.web.nhk'), true);
    assert.equal(apiAllowedDomains.includes('sankei.com'), false, 'Google News feeds do not need publisher-host proxy access');
    assert.equal(apiAllowedDomains.includes('newsdig.tbs.co.jp'), false);
  });
});

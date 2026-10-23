import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The validators are exported from the docs-stats gate; the module is
// import-safe (main() only runs when executed directly), so we can drive the
// failure branches with synthetic fixtures instead of the real, always-valid
// index.html.
import {
  validateIndexLanguageMetadata,
  validateSupportedLanguagesRegistry,
  parseSupportedLanguages,
} from '../scripts/docs-stats.mjs';

const EXPECTED = ['en', 'fa', 'fr'];
const STATS = { localeCodes: EXPECTED, locales: EXPECTED.length };

function buildHtml({ canonical, xdefault, alternates, jsonld } = {}) {
  const parts = ['<html lang="ja">'];
  parts.push(canonical ?? '<link rel="canonical" href="https://worldmonitor-ja-private.vercel.app/" />');
  if (xdefault !== null) {
    parts.push(xdefault ?? '<link rel="alternate" hreflang="x-default" href="https://worldmonitor-ja-private.vercel.app/" />');
  }
  parts.push(...(alternates ?? [
    '<link rel="alternate" hreflang="ja" href="https://worldmonitor-ja-private.vercel.app/" />',
  ]));
  parts.push(jsonld ?? `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'os0x',
    url: 'https://worldmonitor-ja-private.vercel.app/', applicationCategory: 'NewsApplication', operatingSystem: 'Web',
    inLanguage: 'ja', license: 'https://www.gnu.org/licenses/agpl-3.0.html',
    isBasedOn: 'https://github.com/koala73/worldmonitor', codeRepository: 'https://github.com/hirorylabo/os0x-monitor',
  })}</script>`);
  return parts.join('\n');
}

const hit = (failures, substr) => failures.some((f) => f.includes(substr));

describe('validateIndexLanguageMetadata', () => {
  it('returns no failures for consistent language metadata', () => {
    assert.deepEqual(validateIndexLanguageMetadata(STATS, buildHtml()), []);
  });

  it('requires a Japanese document and the actual fork canonical', () => {
    assert.ok(hit(validateIndexLanguageMetadata(STATS, buildHtml().replace('<html lang="ja">', '<html lang="en">')), 'document language must be ja'));
    assert.ok(hit(validateIndexLanguageMetadata(STATS, buildHtml({ canonical: '<link rel="canonical" href="https://www.worldmonitor.app/" />' })), 'canonical URL must identify the os0x deployment'));
  });

  it('requires source, license, attribution and application identity independently', () => {
    const application = JSON.parse(buildHtml().match(/application\/ld\+json">([^<]+)<\/script>/)![1]!);
    for (const [field, value] of Object.entries({
      name: 'World Monitor', url: 'https://other.example/', license: 'MIT',
      codeRepository: 'https://github.com/example/private', isBasedOn: 'https://other.example/',
      applicationCategory: 'ShoppingApplication', operatingSystem: 'Native', '@context': 'https://other.example/',
    })) {
      const jsonld = `<script type="application/ld+json">${JSON.stringify({ ...application, [field]: value })}</script>`;
      assert.ok(hit(validateIndexLanguageMetadata(STATS, buildHtml({ jsonld })), `SoftwareApplication ${field} must identify`), field);
    }
  });

  it('rejects reintroduced official graphs and unmeasured global adoption claims', () => {
    assert.ok(hit(validateIndexLanguageMetadata(STATS, `${buildHtml()}\n<script type="application/ld+json">{"@type":"WebSite","name":"World Monitor"}</script>`), 'only the minimal self-hosted'));
    assert.ok(hit(validateIndexLanguageMetadata(STATS, `${buildHtml()}\n<p>live in 190+ countries</p>`), 'unmeasured hosted-service country adoption'));
  });

  it('flags a missing x-default hreflang link', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({ xdefault: null }));
    assert.ok(hit(failures, 'x-default hreflang link not found'));
  });

  it('flags an x-default href that carries a ?lang param', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({
      xdefault: '<link rel="alternate" hreflang="x-default" href="https://worldmonitor-ja-private.vercel.app/?lang=en" />',
    }));
    assert.ok(hit(failures, 'x-default hreflang href must not set ?lang'));
  });

  it('flags a missing Japanese alternate', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({
      alternates: [],
    }));
    assert.ok(hit(failures, 'hreflang set must contain only x-default and ja'));
    assert.ok(hit(failures, 'missing: ja'));
  });

  it('flags a pseudo-localized query-string alternate', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({
      alternates: [
        '<link rel="alternate" hreflang="ja" href="https://worldmonitor-ja-private.vercel.app/" />',
        '<link rel="alternate" hreflang="fr" href="https://worldmonitor-ja-private.vercel.app/?lang=fr" />',
      ],
    }));
    assert.ok(hit(failures, 'hreflang set must contain only x-default and ja'));
    assert.ok(hit(failures, 'extra: fr'));
    assert.ok(hit(failures, 'query-string locale URLs must not be advertised'));
  });

  it('requires absolute, self-canonical alternate URLs', () => {
    let failures;
    assert.doesNotThrow(() => {
      failures = validateIndexLanguageMetadata(STATS, buildHtml({
        alternates: ['<link rel="alternate" hreflang="ja" href="/dashboard" />'],
      }));
    });
    assert.ok(hit(failures, 'ja hreflang href must be an absolute URL'));
    assert.ok(hit(failures, 'ja hreflang href must equal the canonical URL'));
  });

  it('flags x-default and Japanese alternates that drift from the canonical', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({
      xdefault: '<link rel="alternate" hreflang="x-default" href="https://other.example/" />',
      alternates: ['<link rel="alternate" hreflang="ja" href="https://other.example/" />'],
    }));
    assert.ok(hit(failures, 'x-default hreflang href must equal the canonical URL'));
    assert.ok(hit(failures, 'ja hreflang href must equal the canonical URL'));
  });

  it('flags SoftwareApplication data that claims languages other than the Japanese document', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({
      jsonld: '<script type="application/ld+json">\n{ "@type": "SoftwareApplication", "inLanguage": ["en", "fa"] }\n</script>',
    }));
    assert.ok(hit(failures, 'SoftwareApplication inLanguage must describe the raw Japanese document'));
  });

  it('flags a missing SoftwareApplication JSON-LD block', () => {
    const failures = validateIndexLanguageMetadata(STATS, buildHtml({
      jsonld: '<script type="application/ld+json">\n{ "@type": "WebApplication" }\n</script>',
    }));
    assert.ok(hit(failures, 'SoftwareApplication JSON-LD block not found'));
  });

  it('flags unparseable JSON-LD instead of throwing', () => {
    let failures;
    assert.doesNotThrow(() => {
      failures = validateIndexLanguageMetadata(STATS, buildHtml({
        jsonld: '<script type="application/ld+json">\n{ "@type": "WebSite", }\n</script>',
      }));
    });
    assert.ok(hit(failures, 'JSON-LD could not be parsed'));
  });
});

describe('validateSupportedLanguagesRegistry / parseSupportedLanguages', () => {
  const src = (codes) => `const SUPPORTED_LANGUAGES = [${codes.map((c) => `'${c}'`).join(', ')}] as const;`;

  it('parses the SUPPORTED_LANGUAGES literal array', () => {
    assert.deepEqual(parseSupportedLanguages(src(['en', 'fa', 'fr'])), ['en', 'fa', 'fr']);
  });

  it('returns no failures when the runtime list matches src/locales', () => {
    assert.deepEqual(validateSupportedLanguagesRegistry(STATS, src(['fr', 'en', 'fa'])), []);
  });

  it('flags drift between SUPPORTED_LANGUAGES and src/locales', () => {
    const failures = validateSupportedLanguagesRegistry(STATS, src(['en', 'fa']));
    assert.ok(hit(failures, 'SUPPORTED_LANGUAGES does not match src/locales'));
    assert.ok(hit(failures, 'missing: fr'));
  });

  it('flags an unparseable SUPPORTED_LANGUAGES declaration', () => {
    const failures = validateSupportedLanguagesRegistry(STATS, 'no array here');
    assert.ok(hit(failures, 'could not parse SUPPORTED_LANGUAGES'));
  });
});

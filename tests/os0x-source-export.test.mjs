import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { exclusionReason, compactArchivePaths, inspectSource, scanCredentialLiterals, writeSourceExport } from '../scripts/export-os0x-source.mjs';

test('export policy excludes local state and notes while retaining build source and environment examples', () => {
  for (const path of ['.env', '.env.local', '.vercel/project.json', '.aws/credentials', 'task/PLAN.md', 'docs/internal/ops.md',
    'docs/evidence/shot.png', 'CLAUDE.md', 'compound-engineering.local.md', 'pro-test/.env.production']) assert.ok(exclusionReason(path), path);
  for (const path of ['.env.example', 'AGENTS.md', 'api/translate-ja.js', 'src/assets/a.png', 'shared/schema.json',
    'scripts/lib/main-module.mjs', 'scripts/data/a.json', 'proto/worldmonitor/news.proto', 'convex/companyMonitoring/evidence.ts']) assert.equal(exclusionReason(path), null, path);
  assert.throws(() => exclusionReason('../.env'), /Unsafe/);
});

test('literal scanner reports locations and identifiers without matched values', () => {
  const token = 'AIza' + 'mV8gN2qR7sT4uW9xY6zB3dF5hJ1kL0pC8aE';
  const findings = scanCredentialLiterals('api/example.js', `const credential = "${token}";`);
  assert.equal(findings[0].kind, 'google-api-key');
  assert.equal(findings[0].path, 'api/example.js');
  assert.ok(!JSON.stringify(findings).includes(token));
  assert.deepEqual(scanCredentialLiterals('src/cache.ts', 'const CACHE_KEY="country:resilience:history:v1";'), []);
});

test('public webhook fixture exception is revoked whenever the file changes', () => {
  const path = 'public/.well-known/webhook-sample.json';
  const fixture = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.deepEqual(scanCredentialLiterals(path, fixture), []);
  const changed = scanCredentialLiterals(path, `${fixture}\n`);
  assert.ok(changed.some((finding) => finding.name === 'secret'));
});

test('compact path selection never reintroduces an excluded descendant', () => {
  assert.deepEqual(compactArchivePaths([
    { path: 'src/a.ts', excluded: null }, { path: 'src/b.ts', excluded: null },
    { path: 'docs/public.md', excluded: null }, { path: 'docs/internal/plan.md', excluded: 'notes' },
  ]), ['docs/public.md', 'src']);
});

test('committed export preserves exact bytes and licenses, excludes private files and contains no Git history', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'os0x-export-test-'));
  const root = join(scratch, 'private'); const output = join(scratch, 'public'); mkdirSync(root);
  const fixture = {
    LICENSE: 'GNU AFFERO GENERAL PUBLIC LICENSE\n',
    'README.md': 'https://github.com/hirorylabo/os0x-monitor\nhttps://github.com/koala73/worldmonitor v2.11.3\n',
    'package.json': JSON.stringify({ scripts: { 'build:os0x': 'vite build' } }),
    'package-lock.json': '{}', '.npmrc': '', '.nvmrc': '24', '.env.example': 'GEMINI_API_KEY=\n',
    'AGENTS.md': 'Public contributor contract', 'ARCHITECTURE.md': 'Architecture', 'index.html': '<html lang="ja">',
    'vite.config.ts': '', 'tsconfig.json': '{}', 'tsconfig.api.json': '{}',
    'scripts/generate-inventory-facts.mjs': '', 'scripts/docs-stats.mjs': '', 'scripts/source-attribution.mjs': '',
    'shared/source-attribution-manifest.json': '{}', 'src/app.ts': 'export const answer = 42;\n',
    '.env.local': 'private fixture', 'task/plan.md': 'private notes', '.vercel/project.json': 'private fixture',
  };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Source fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, stdio: 'pipe' });
  try {
    for (const [path, content] of Object.entries(fixture)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
    git('init', '-b', 'main'); git('add', '.'); git('commit', '-m', 'Fixture source');
    const report = inspectSource({ root }); assert.deepEqual(report.findings, []);
    const result = writeSourceExport(report, { root, output });
    assert.equal(result.historyIncluded, false); assert.equal(existsSync(join(output, '.git')), false);
    assert.equal(existsSync(join(output, '.env.local')), false); assert.equal(existsSync(join(output, 'task')), false);
    assert.equal(existsSync(join(output, '.vercel')), false);
    assert.equal(readFileSync(join(output, 'src/app.ts'), 'utf8'), fixture['src/app.ts']);
    const manifest = JSON.parse(readFileSync(join(output, 'SOURCE_EXPORT_MANIFEST.json'), 'utf8'));
    assert.equal(manifest.sourceTree, report.sourceTree); assert.equal(manifest.files.length, report.files.length);
    assert.ok(!JSON.stringify(manifest).includes('task/plan.md'));
    assert.ok(!JSON.stringify(manifest).includes('.env.local'));
    assert.throws(() => writeSourceExport(report, { root, output }), /already exists/);
    assert.throws(() => writeSourceExport(report, { root, output: join(root, '..looks-outside') }), /outside/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

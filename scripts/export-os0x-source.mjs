#!/usr/bin/env node
// Trusted export tooling: reads Git objects and files as data; never executes
// repository build scripts, reads credential values, or contacts a remote.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED_PARTS = new Set([
  '.git', '.vercel', '.aws', '.ssh', '.gnupg', '.codex', '.codex-ocx', '.agents', '.agent', '.claude',
  '.factory', '.windsurf', '.audit', 'node_modules', 'dist', 'target', 'coverage', 'playwright-report',
  'test-results', 'task', 'tasks', 'evidence', '.cache',
]);
const PRIVATE_DOC_DIRS = /^(?:docs\/(?:internal|research|plans|brainstorms|ideation|audits|archive|Docs_To_Review|solutions|perf)\/)/;
const EXCLUDED_NAMES = /^(?:CLAUDE\.md|ROADMAP\.md|compound-engineering\.local\.md|\.impeccable\.md|auth\.json|credentials(?:\.json)?|\.DS_Store|SOURCE_EXPORT_MANIFEST\.json)$/i;
const KEY_PATTERNS = [
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ['groq-token', /\bgsk_[A-Za-z0-9]{30,}\b/g],
  ['openai-token', /(?<![A-Za-z])sk-(?:(?:proj-|svcacct-|ant-api\d+-)[A-Za-z0-9_-]{35,}|[A-Za-z0-9]{35,})\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
];

export function exclusionReason(path) {
  const parts = path.split('/');
  if (!path || isAbsolute(path) || parts.some((part) => !part || part === '.' || part === '..') || /[\x00-\x1f\x7f]/.test(path)) {
    throw new Error('Unsafe source path');
  }
  if (parts.some((part) => EXCLUDED_PARTS.has(part))) return 'local-state-or-internal-notes';
  if (PRIVATE_DOC_DIRS.test(path)) return 'internal-documentation';
  if (parts.some((part) => /^\.env(?:$|[.-])/.test(part) && part !== '.env.example')) return 'environment-file';
  if (parts.some((part) => EXCLUDED_NAMES.test(part))) return 'local-or-task-document';
  if (/\.(?:pem|p12|pfx|key|keychain|log|har|pcap|pcapng)$/i.test(path)) return 'credential-or-local-evidence-file';
  return null;
}

function isObviousExample(value) {
  return /example|fixture|synthetic|dummy|placeholder|changeme|replace[_-]?me|your[_-]|(?:^|[-_])test(?:[-_]|$)|for-tests|not-a-real|correct[-_]?horse/i.test(value)
    || /abcdefghijklmnopqrstuvwxyz|ABCDEFGHIJKLMNOPQRSTUVWXYZ|0123456789/.test(value)
    || new Set(value).size < 9;
}

function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  return [...counts.values()].reduce((total, count) => {
    const p = count / value.length; return total - p * Math.log2(p);
  }, 0);
}

// Findings intentionally contain names/locations only, never matched values.
export function scanCredentialLiterals(path, text) {
  // Reviewed unchanged upstream public HMAC verification fixture. Pin the whole
  // file, so modifying it or appending a credential removes this exception.
  if (path === 'public/.well-known/webhook-sample.json'
    && createHash('sha256').update(text).digest('hex') === '63b3739d9a4bdccd9e6c86008452c8b763de4617d9d964e339e837b44539dc26') return [];
  const findings = [];
  const add = (kind, index, name) => {
    const finding = { path, line: text.slice(0, index).split('\n').length, kind, ...(name ? { name } : {}) };
    if (!findings.some((item) => item.path === finding.path && item.line === finding.line && item.kind === kind)) findings.push(finding);
  };
  for (const [kind, pattern] of KEY_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (kind === 'openai-token' && !(/[A-Z]/.test(match[0]) && /\d/.test(match[0]))) continue;
      if (kind === 'private-key' || !isObviousExample(match[0])) add(kind, match.index);
    }
  }
  const assignment = /\b([A-Z][A-Z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|AUTH_SECRET|CLIENT_SECRET|PASSWORD|BEARER_TOKEN|SIGNING_SECRET|HMAC_SECRET|_SECRET)|API_KEY|SECRET|TOKEN|PASSWORD|apiKey|api_key|password|secret|token)["']?\s*[:=]\s*(["'])([^"'\r\n]{24,})\2/g;
  for (const match of text.matchAll(assignment)) {
    const value = match[3];
    const randomHex = /^[A-Fa-f0-9]{32,}$/.test(value) && entropy(value) >= 3;
    if (!/^[A-Za-z0-9_+/.=-]+$/.test(value) || value.includes('://') || isObviousExample(value)
      || (!randomHex && entropy(value) < 4.5)) continue;
    add('credential-assignment', match.index, match[1]);
  }
  return findings;
}

function git(root, args, options = {}) {
  // No shell, no credential-bearing Git remote operation and no repo hooks.
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, maxBuffer: 256 * 1024 * 1024, ...options,
  });
}

function treeEntries(root, commit) {
  return git(root, ['ls-tree', '-rz', '--full-tree', commit], { encoding: 'utf8' })
    .split('\0').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t');
      const [mode, type, oid] = line.slice(0, tab).split(' ');
      return { mode, type, oid, path: line.slice(tab + 1) };
    });
}

export function compactArchivePaths(entries) {
  const root = { children: new Map(), entries: [] };
  for (const entry of entries) {
    const parts = entry.path.split('/'); let node = root;
    for (const part of parts) {
      if (!node.children.has(part)) node.children.set(part, { children: new Map(), entries: [] });
      node = node.children.get(part); node.entries.push(entry);
    }
  }
  const paths = [];
  const visit = (node, path) => {
    if (node.entries.length && node.entries.every((entry) => !entry.excluded)) { paths.push(path); return; }
    for (const [name, child] of node.children) visit(child, path ? `${path}/${name}` : name);
  };
  visit(root, '');
  return paths.sort();
}

export function inspectSource({ root = ROOT, ref = 'HEAD' } = {}) {
  const commit = git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  const tree = git(root, ['rev-parse', `${commit}^{tree}`], { encoding: 'utf8' }).trim();
  const entries = treeEntries(root, commit).map((entry) => ({ ...entry, excluded: exclusionReason(entry.path) }));
  const included = entries.filter((entry) => !entry.excluded);
  const invalid = included.filter((entry) => !['100644', '100755'].includes(entry.mode) || entry.type !== 'blob');
  if (invalid.length) throw new Error(`Export rejects symlinks/submodules/special entries: ${invalid.map((entry) => entry.path).join(', ')}`);
  const required = ['LICENSE', 'README.md', 'AGENTS.md', 'ARCHITECTURE.md', 'package.json', 'package-lock.json', '.npmrc', '.nvmrc',
    '.env.example', 'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.api.json', 'scripts/generate-inventory-facts.mjs',
    'scripts/docs-stats.mjs', 'scripts/source-attribution.mjs', 'shared/source-attribution-manifest.json'];
  const names = new Set(included.map((entry) => entry.path));
  const missing = required.filter((path) => !names.has(path));
  if (missing.length) throw new Error(`Required build/license source missing: ${missing.join(', ')}`);
  const findings = [];
  const files = [];
  for (let start = 0; start < included.length; start += 64) {
    const group = included.slice(start, start + 64);
    const output = git(root, ['cat-file', '--batch'], { input: group.map((entry) => entry.oid).join('\n') + '\n' });
    let offset = 0;
    for (const entry of group) {
      const end = output.indexOf(10, offset);
      const header = output.subarray(offset, end).toString('utf8').split(' ');
      const size = Number(header[2]);
      if (header[0] !== entry.oid || header[1] !== 'blob' || !Number.isSafeInteger(size)) throw new Error('Invalid Git batch response');
      const bytes = output.subarray(end + 1, end + 1 + size); offset = end + size + 2;
      if (bytes.length !== size) throw new Error('Truncated Git blob');
      if (entry.path === 'LICENSE' && !bytes.toString('utf8').includes('GNU AFFERO GENERAL PUBLIC LICENSE')) throw new Error('AGPL LICENSE is required');
      if (entry.path === 'README.md' && !['https://github.com/hirorylabo/os0x-monitor', 'https://github.com/koala73/worldmonitor', 'v2.11.3'].every((value) => bytes.toString('utf8').includes(value))) throw new Error('Fork source offer and upstream attribution are required');
      if (entry.path === 'package.json' && typeof JSON.parse(bytes.toString('utf8')).scripts?.['build:os0x'] !== 'string') throw new Error('build:os0x script is required');
      if (!bytes.includes(0)) findings.push(...scanCredentialLiterals(entry.path, bytes.toString('utf8')));
      files.push({ path: entry.path, mode: entry.mode, gitBlob: entry.oid, size,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return { formatVersion: 1, sourceCommit: commit, sourceTree: tree, files,
    excluded: entries.filter((entry) => entry.excluded).map(({ path, excluded: reason }) => ({ path, reason })),
    findings, archivePaths: compactArchivePaths(entries) };
}

export function writeSourceExport(report, { root = ROOT, output } = {}) {
  if (!output) throw new Error('--output is required with --write');
  if (report.findings.length) throw new Error('Credential candidates must be reviewed before export');
  const destination = resolve(output);
  const rel = relative(resolve(root), destination);
  if (!(rel === '..' || rel.startsWith(`..${sep}`)) || isAbsolute(rel)) throw new Error('Export output must be outside the private checkout');
  if (existsSync(destination)) throw new Error('Export output already exists; choose a new directory');
  const scratch = mkdtempSync(join(tmpdir(), 'os0x-source-archive-'));
  let created = false;
  try {
    const tar = join(scratch, 'source.tar');
    git(root, ['archive', '--format=tar', `--output=${tar}`, report.sourceCommit, '--', ...report.archivePaths]);
    const actual = execFileSync('tar', ['-tf', tar], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
      .split('\n').filter((path) => path && !path.endsWith('/')).sort();
    const expected = report.files.map((entry) => entry.path).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Archive differs from reviewed file list (check export-ignore attributes)');
    mkdirSync(destination, { recursive: false });
    created = true;
    execFileSync('tar', ['-xf', tar, '-C', destination, '--no-same-owner']);
    for (const file of report.files) {
      const hash = createHash('sha256').update(readFileSync(join(destination, file.path))).digest('hex');
      if (hash !== file.sha256) throw new Error(`Export hash mismatch: ${file.path}`);
    }
    // This manifest contains no file contents, secret values, local paths or
    // private history. A new public repository can be initialized separately.
    const { archivePaths: _archivePaths, findings: _findings, excluded, ...manifest } = report;
    manifest.exclusionCounts = excluded.reduce((counts, entry) => {
      counts[entry.reason] = (counts[entry.reason] || 0) + 1; return counts;
    }, {});
    writeFileSync(join(destination, 'SOURCE_EXPORT_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    return { output: destination, files: report.files.length, sourceCommit: report.sourceCommit, historyIncluded: false };
  } catch (error) {
    if (created) rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function scanWorkingTree(root = ROOT) {
  const paths = [...new Set(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean))];
  const findings = [];
  let scannedTextFiles = 0;
  for (const path of paths) {
    if (exclusionReason(path)) continue;
    let stat;
    try { stat = lstatSync(join(root, path)); } catch { continue; }
    if (stat.isSymbolicLink()) { findings.push({ path, kind: 'unsafe-symlink' }); continue; }
    if (!stat.isFile()) continue;
    const bytes = readFileSync(join(root, path));
    if (bytes.includes(0)) continue;
    scannedTextFiles += 1;
    findings.push(...scanCredentialLiterals(path, bytes.toString('utf8')));
  }
  return { workingTree: true, scannedTextFiles, findings, valuesIncluded: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--scan-worktree')) {
      if (args.includes('--write')) throw new Error('A working-tree scan cannot create a committed-source export');
      const report = scanWorkingTree();
      console.log(JSON.stringify(report, null, 2));
      if (report.findings.length) process.exitCode = 1;
    } else {
    const option = (name) => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
    const report = inspectSource({ ref: option('--ref') || 'HEAD' });
    const summary = { sourceCommit: report.sourceCommit, sourceTree: report.sourceTree,
      includedFiles: report.files.length, excludedFiles: report.excluded.length, findings: report.findings,
      excludedPaths: report.excluded, dryRun: !args.includes('--write') };
    console.log(JSON.stringify(summary, null, 2));
    if (report.findings.length) process.exitCode = 1;
    else if (args.includes('--write')) console.log(JSON.stringify(writeSourceExport(report, { output: option('--output') }), null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

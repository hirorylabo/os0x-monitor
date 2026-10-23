import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../scripts/vercel-ignore.sh', import.meta.url));

function withRepository(run) {
  const root = mkdtempSync(join(tmpdir(), 'os0x-vercel-ignore-'));
  const git = (...args) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Build fixture', '-c', 'user.email=fixture@example.invalid', ...args,
  ], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commitFile = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    git('add', path);
    git('commit', '-m', `Change ${path}`);
    return git('rev-parse', 'HEAD');
  };
  const decide = (branch, previous) => {
    const result = spawnSync('bash', [script], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, VERCEL_GIT_COMMIT_REF: branch, VERCEL_GIT_PREVIOUS_SHA: previous },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.ok([0, 1].includes(result.status), result.stderr);
    return result.status;
  };
  try {
    git('init', '-b', 'main');
    const base = commitFile('src/main.ts', 'export const value = 1;\n');
    run({ git, commitFile, decide, base });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('same-SHA Preview redeploy builds when its shallow clone lacks origin/main', () => {
  withRepository(({ git, decide, base }) => {
    git('checkout', '-b', 'update/os0x-v2.11.3');
    assert.equal(decide('update/os0x-v2.11.3', base), 1);
  });
});

test('same-SHA Preview redeploy builds even when the branch only changed documentation', () => {
  withRepository(({ git, commitFile, decide, base }) => {
    git('update-ref', 'refs/remotes/origin/main', base);
    git('checkout', '-b', 'docs/update');
    const head = commitFile('docs/guide.md', 'Updated guide\n');
    assert.equal(decide('docs/update', head), 1);
  });
});

test('same-SHA main redeploy continues to build', () => {
  withRepository(({ decide, base }) => assert.equal(decide('main', base), 1));
});

test('new documentation-only main and Preview commits still skip', () => {
  withRepository(({ git, commitFile, decide, base }) => {
    git('update-ref', 'refs/remotes/origin/main', base);
    commitFile('docs/guide.md', 'Updated guide\n');
    assert.equal(decide('main', base), 0);
    assert.equal(decide('docs/update', base), 0);
  });
});

test('new Preview web changes build using either merge-base or the shallow-clone fallback', () => {
  withRepository(({ git, commitFile, decide, base }) => {
    git('checkout', '-b', 'update/web');
    commitFile('src/main.ts', 'export const value = 2;\n');
    assert.equal(decide('update/web', base), 1);
    git('update-ref', 'refs/remotes/origin/main', base);
    assert.equal(decide('update/web', base), 1);
  });
});

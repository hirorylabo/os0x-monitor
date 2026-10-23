import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function publicApiSources(directory = 'api') {
  return readdirSync(`${root}/${directory}`, { withFileTypes: true }).flatMap((entry) => {
    // Vercel's API file discovery treats underscore directories and files as
    // private implementation modules. Apply this before descending.
    if (entry.name.startsWith('_')) return [];
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return publicApiSources(path);
    if (!/\.(?:[cm]?js|tsx?)$/.test(path) || /(?:\.test\.|\.d\.(?:ts|mts)$)/.test(path)) return [];
    return [path];
  });
}

test('MCP helpers are private implementation, keeping Hobby Node function count below twelve', () => {
  assert.equal(existsSync(`${root}/api/mcp`), false);
  assert.ok(existsSync(`${root}/api/_mcp/handler.ts`));
  const candidates = publicApiSources();
  assert.ok(candidates.length > 50, 'do not hide the actual API inventory to pass the limit');
  assert.ok(candidates.every((path) => !path.startsWith('api/mcp/')));
  const nodes = candidates.filter((path) => !/export\s+const\s+config\s*=\s*\{[^}]*\bruntime\s*:\s*['"]edge['"]/.test(readFileSync(`${root}/${path}`, 'utf8')));
  assert.deepEqual(nodes.sort(), ['api/mcp-proxy.ts', 'api/og-story.js', 'api/story.js']);
  assert.ok(nodes.length <= 12);
});

test('public MCP facade preserves transport exports and public rewrite URLs', async () => {
  const facade = await import('../api/mcp.ts');
  const implementation = await import('../api/_mcp/handler.ts');
  const auth = await import('../api/_mcp/auth.ts');
  const registry = await import('../api/_mcp/registry/index.ts');
  assert.equal(facade.default, implementation.default);
  assert.equal(facade.mcpHandler, implementation.mcpHandler);
  assert.equal(facade.resolveAuthContext, auth.resolveAuthContext);
  assert.equal(facade.TOOL_REGISTRY, registry.TOOL_REGISTRY);
  const config = JSON.parse(readFileSync(`${root}/vercel.json`, 'utf8'));
  for (const source of ['/mcp', '/.well-known/mcp', '/.well-known/mcp.json']) {
    assert.equal(config.rewrites.find((rule) => rule.source === source)?.destination, '/api/mcp');
  }
  const redirects = readFileSync(`${root}/api/oauth/_redirect-uri.js`, 'utf8');
  assert.ok(redirects.includes('https://claude.ai/api/mcp/auth_callback'));
  assert.ok(redirects.includes('https://claude.com/api/mcp/auth_callback'));
  assert.ok(!redirects.includes('/api/_mcp/'));
});

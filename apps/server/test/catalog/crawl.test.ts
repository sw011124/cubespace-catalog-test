import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crawl, summaryMarkdown, type Env } from '../../src/catalog/crawl.ts';
import { checkItem, loadVocab } from '../../src/catalog/item.ts';
import { MAX_NEW_PER_RUN } from '../../src/catalog/limits.ts';
import { sri512 } from '../../src/catalog/pkg.ts';
import type { Ask } from '../../src/catalog/review.ts';
import { fakeHttp } from './fake.ts';

const NOW = new Date('2026-10-16T03:17:00Z');
const R = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const I = 'sha512-' + 'B'.repeat(86) + '==';

function catalogRoot() {
  const root = mkdtempSync(join(tmpdir(), 'catalog-'));
  writeFileSync(join(root, 'vocab.json'), JSON.stringify({ task: ['bugfix', 'feature'], stack: [], capability: ['github'], stage: ['plan', 'implement'] }));
  return root;
}

function tarball(): Buffer {
  const src = mkdtempSync(join(tmpdir(), 'tgz-'));
  mkdirSync(join(src, 'package'));
  writeFileSync(join(src, 'package', 'index.js'), 'server.tool("get_issue");\nserver.tool("create_pr");\n');
  execFileSync('tar', ['-czf', join(src, 'p.tgz'), '-C', src, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return readFileSync(join(src, 'p.tgz'));
}

// 검토자와 태그 붙이기를 흉내 낸다. 받은 지시문의 첫 줄로 누구인지 가린다.
function fakeAsk(calls: string[]): Ask {
  return async (system) => {
    if (system.includes('보안 검토자')) {
      calls.push('review');
      return { ok: true, json: {
        verdict: 'ok', rw: 'R', tools: [{ name: 'get_issue', rw: 'R' }, { name: 'create_pr', rw: 'W' }],
        findings: [{ file: 'package/index.js', line: 1, kind: 'ok_evidence', note: 'registers tools only' }], summary: 'GitHub 이슈 읽기, PR 올리기',
      } };
    }
    calls.push('tag');
    return { ok: true, json: { task: ['bugfix'], stage: ['plan', 'implement'], capability: ['github'], needs_shell: false, windows: 'unknown', new_chips: [] } };
  };
}

function mcpRoutes(servers: { name: string; stars: number }[], tgz: Buffer) {
  const routes: Record<string, unknown> = {
    [`${R}?limit=100&version=latest`]: { servers: servers.map(({ name }) => ({
      server: { name, version: '1.0.0', repository: { url: `https://github.com/acme/${name.split('/')[1]}` },
        packages: [{ registryType: 'npm', identifier: `@acme/${name.split('/')[1]}`, version: '1.0.0', transport: { type: 'stdio' } }] },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
    })), metadata: {} },
    'https://api.osv.dev/v1/querybatch': { results: [{}, {}] },
    'https://r.example/p.tgz': tgz,
  };
  for (const { name, stars } of servers) {
    const short = name.split('/')[1];
    routes[`https://registry.npmjs.org/@acme/${short}/1.0.0`] = { dist: { integrity: sri512(tgz), tarball: 'https://r.example/p.tgz' } };
    routes[`https://api.github.com/repos/acme/${short}`] = {
      stargazers_count: stars, forks_count: 3, archived: false, pushed_at: '2026-10-01T00:00:00Z', license: { spdx_id: 'MIT' }, default_branch: 'main' };
  }
  return routes;
}

const env = (root: string, routes: Record<string, unknown>, calls: string[]): Env => ({
  http: fakeHttp(routes).http, ask: fakeAsk(calls), now: NOW, root, lock: () => [{ name: 'zod', version: '3.0.0', integrity: I }],
});

describe('crawl mcp', () => {
  it('adds a server that passes every check as a valid team-approved item, then skips it next run', async () => {
    const root = catalogRoot();
    const calls: string[] = [];
    const routes = mcpRoutes([{ name: 'io.github.acme/gh', stars: 300 }, { name: 'io.github.acme/tiny', stars: 3 }], tarball());

    const s = await crawl('mcp', env(root, routes, calls));
    expect(s.added).toEqual(['io-github-acme-gh']);
    expect(s.dropped.map((n) => n.id)).toEqual(['io-github-acme-tiny']);
    expect(calls).toEqual(['review', 'tag']); // 기준 미달은 Claude를 부르지 않는다

    const item = JSON.parse(readFileSync(join(root, 'items', 'mcp', 'io-github-acme-gh.json'), 'utf8'));
    expect(checkItem(item, loadVocab(join(root, 'vocab.json')))).toEqual([]);
    expect(item).toMatchObject({ approval: 'team', rw: 'W', package: { deps: [{ name: 'zod' }] } });
    const state = JSON.parse(readFileSync(join(root, 'state', 'mcp.json'), 'utf8'));
    expect(state.since).toBe(NOW.toISOString());
    expect(state.seen['io-github-acme-tiny'].decision).toBe('drop');

    // 다음 날 Registry가 같은 판을 다시 돌려줘도(updated_since) 이미 있는 판이라 건너뛴다.
    routes[`${R}?limit=100&version=latest&updated_since=2026-10-16T03%3A17%3A00.000Z`] = routes[`${R}?limit=100&version=latest`];
    const again = await crawl('mcp', { ...env(root, routes, calls), now: new Date('2026-10-17T03:17:00Z') });
    expect([again.added, again.updated, again.dropped]).toEqual([[], [], []]);
    expect(calls).toHaveLength(2);
  });

  it('drops a server whose GitHub repository is gone, and stops at the first rate limit without moving `since`', async () => {
    const root = catalogRoot();
    const routes = mcpRoutes([{ name: 'io.github.acme/a', stars: 300 }, { name: 'io.github.acme/b', stars: 300 }, { name: 'io.github.acme/c', stars: 300 }], tarball());
    delete routes['https://api.github.com/repos/acme/a'];
    const base = fakeHttp(routes).http;
    const seen: string[] = [];
    const http: typeof base = async (u, i) => {
      seen.push(String(u));
      return String(u) === 'https://api.github.com/repos/acme/b' ? new Response('limit', { status: 403 }) : base(u, i);
    };
    const s = await crawl('mcp', { ...env(root, routes, []), http });
    expect(s.dropped.map((n) => [n.id, n.reasons[0]])).toEqual([['io-github-acme-a', 'GitHub repository acme/a not found']]);
    expect(s.errors.map((n) => n.id)).toEqual(['io-github-acme-b']);
    expect(seen.some((u) => u.includes('acme/c'))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, 'state', 'mcp.json'), 'utf8')).since).toBeNull();
  });

  it('drops (not errors) a server whose npm package is gone or whose dependencies cannot be resolved', async () => {
    const root = catalogRoot();
    const routes = mcpRoutes([{ name: 'io.github.acme/gone', stars: 300 }, { name: 'io.github.acme/tangle', stars: 300 }], tarball());
    delete routes['https://registry.npmjs.org/@acme/gone/1.0.0'];
    const lock = (id: string) => { if (id === '@acme/tangle') throw new Error('npm error code ERESOLVE\nmore'); return []; };
    const s = await crawl('mcp', { ...env(root, routes, []), lock });
    expect(s.dropped.map((n) => n.reasons[0])).toEqual([
      'npm @acme/gone@1.0.0 not found', 'npm could not resolve dependencies: npm error code ERESOLVE']);
    expect(s.errors).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, 'state', 'mcp.json'), 'utf8')).since).toBe(NOW.toISOString());
  });

  it('reviews a server only once even if the registry lists it twice in one run', async () => {
    const root = catalogRoot();
    const calls: string[] = [];
    const routes = mcpRoutes([{ name: 'io.github.acme/gh', stars: 300 }], tarball());
    const page = routes[`${R}?limit=100&version=latest`] as { servers: unknown[] };
    page.servers.push(page.servers[0]);
    const s = await crawl('mcp', env(root, routes, calls));
    expect(s.added).toEqual(['io-github-acme-gh']);
    expect(calls).toEqual(['review', 'tag']);
  });

  it('seed: looks only at the named servers and starts `since` now, so the first run does not walk the whole registry', async () => {
    const root = catalogRoot();
    const routes = mcpRoutes([{ name: 'io.github.acme/gh', stars: 300 }], tarball());
    const entry = (routes[`${R}?limit=100&version=latest`] as { servers: unknown[] }).servers[0];
    delete routes[`${R}?limit=100&version=latest`];
    routes[`${R}/io.github.acme%2Fgh/versions/latest`] = entry;
    const s = await crawl('mcp', env(root, routes, []), ['io.github.acme/gh', 'io.github.nobody/none']);
    expect(s.added).toEqual(['io-github-acme-gh']);
    expect(s.dropped.map((n) => n.id)).toEqual(['io-github-nobody-none']);
    expect(JSON.parse(readFileSync(join(root, 'state', 'mcp.json'), 'utf8')).since).toBe(NOW.toISOString());
  });

  it('stops reviewing new servers at the per-run cap and keeps `since` so the rest come next run', async () => {
    const root = catalogRoot();
    const calls: string[] = [];
    const n = MAX_NEW_PER_RUN.mcp + 2;
    const routes = mcpRoutes(Array.from({ length: n }, (_, i) => ({ name: `io.github.acme/s${i}`, stars: 300 })), tarball());
    const s = await crawl('mcp', env(root, routes, calls));
    expect(s.added).toHaveLength(MAX_NEW_PER_RUN.mcp);
    expect(s.capped).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'state', 'mcp.json'), 'utf8')).since).toBeNull();
    expect(summaryMarkdown(s, '2026-10-16')).toContain('다음 실행에서 본다');
  });
});

describe('crawl skill', () => {
  const GH = 'https://api.github.com/repos';
  const C = 'c'.repeat(40);
  const raw = (repo: string, p: string) => `https://raw.githubusercontent.com/${repo}/${C}/${p}`;
  const blob = (path: string) => ({ path, type: 'blob', sha: 'b', size: 20 });
  const treeNode = (path: string, sha = `t:${path}`) => ({ path, type: 'tree', sha, size: 0 });

  function skillRoutes() {
    const routes: Record<string, unknown> = {};
    const repoMeta = { stargazers_count: 1000, forks_count: 10, archived: false, pushed_at: '2026-10-01T00:00:00Z', license: null, default_branch: 'main' };
    for (const repo of ['anthropics/skills', 'anthropics/claude-plugins-official']) {
      routes[`${GH}/${repo}`] = repoMeta;
      routes[`${GH}/${repo}/branches/main`] = { commit: { sha: C, commit: { tree: { sha: `root-${repo}` } } } };
      routes[raw(repo, '.claude-plugin/marketplace.json')] = { plugins: [] };
      routes[`${GH}/${repo}/git/trees/root-${repo}?recursive=1`] = { truncated: false, tree: [] };
    }
    const repo = 'anthropics/skills';
    routes[raw(repo, '.claude-plugin/marketplace.json')] = { plugins: [{ name: 'x', source: './', skills: ['./skills/good', './skills/closed', './skills/scripted'] }] };
    routes[`${GH}/${repo}/git/trees/root-${repo}?recursive=1`] = { truncated: false, tree: [
      treeNode('skills'), treeNode('skills/good'), blob('skills/good/SKILL.md'), blob('skills/good/LICENSE.txt'),
      treeNode('skills/closed'), blob('skills/closed/SKILL.md'), blob('skills/closed/LICENSE.txt'),
      treeNode('skills/scripted'), blob('skills/scripted/SKILL.md'), blob('skills/scripted/LICENSE.txt'), blob('skills/scripted/run.py'),
    ] };
    routes[raw(repo, 'skills/good/SKILL.md')] = '---\nname: good\n---\nRead the diff and report issues.';
    routes[raw(repo, 'skills/good/LICENSE.txt')] = 'Apache License\nVersion 2.0, January 2004';
    routes[raw(repo, 'skills/closed/SKILL.md')] = '---\nname: closed\n---\nFill PDF forms.';
    routes[raw(repo, 'skills/closed/LICENSE.txt')] = '© 2025 Anthropic, PBC. All rights reserved.';
    routes[raw(repo, 'skills/scripted/SKILL.md')] = '---\nname: scripted\n---\nRun run.py.';
    routes[raw(repo, 'skills/scripted/LICENSE.txt')] = 'MIT License';
    return routes;
  }

  const skillAsk = (calls: string[]): Ask => async (system) => {
    calls.push(system.includes('보안 검토자') ? 'review' : 'tag');
    return system.includes('보안 검토자')
      ? { ok: true, json: { verdict: 'ok', rw: 'R', tools: [], findings: [{ file: 'SKILL.md', line: 4, kind: 'ok_evidence', note: 'read only' }], summary: '검토 지침' } }
      : { ok: true, json: { task: ['bugfix'], stage: ['plan'], capability: [], needs_shell: false, windows: 'yes', new_chips: [] } };
  };

  it('auto-approves an open-licensed ok skill and drops closed or scripted ones', async () => {
    const root = catalogRoot();
    const calls: string[] = [];
    const s = await crawl('skill', { http: fakeHttp(skillRoutes()).http, ask: skillAsk(calls), now: NOW, root, lock: () => [] });
    expect(s.added).toEqual(['anthropics-skills-good']);
    expect(Object.fromEntries(s.dropped.map((n) => [n.id, n.reasons[0]]))).toEqual({
      'anthropics-skills-closed': 'license none not allowed',
      'anthropics-skills-scripted': 'skill contains scripts (U-82): run.py',
    });
    const item = JSON.parse(readFileSync(join(root, 'items', 'skill', 'anthropics-skills-good.json'), 'utf8'));
    expect(checkItem(item, loadVocab(join(root, 'vocab.json')))).toEqual([]);
    expect(item).toMatchObject({ approval: 'auto', license: 'Apache-2.0', version: 't:skills/good', commit: C });
  });

  it('keeps going when one skill source is broken and does not withdraw that source\'s items', async () => {
    const root = catalogRoot();
    await crawl('skill', { http: fakeHttp(skillRoutes()).http, ask: skillAsk([]), now: NOW, root, lock: () => [] });
    const routes = skillRoutes();
    delete routes['https://api.github.com/repos/anthropics/skills/branches/main'];
    const s = await crawl('skill', { http: fakeHttp(routes).http, ask: skillAsk([]), now: NOW, root, lock: () => [] });
    expect(s.errors.map((n) => n.id)).toEqual(['anthropics-skills']);
    expect(s.withdrawn).toEqual([]);
  });

  it('withdraws a skill that disappeared from its repository', async () => {
    const root = catalogRoot();
    await crawl('skill', { http: fakeHttp(skillRoutes()).http, ask: skillAsk([]), now: NOW, root, lock: () => [] });
    const routes = skillRoutes();
    routes[`https://raw.githubusercontent.com/anthropics/skills/${C}/.claude-plugin/marketplace.json`] = { plugins: [] };
    const s = await crawl('skill', { http: fakeHttp(routes).http, ask: skillAsk([]), now: NOW, root, lock: () => [] });
    expect(s.withdrawn).toEqual(['anthropics-skills-good']);
    expect(readdirSync(join(root, 'items', 'skill'))).toEqual(['anthropics-skills-good.json']);
  });
});

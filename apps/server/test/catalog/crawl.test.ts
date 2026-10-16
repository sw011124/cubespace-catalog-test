import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crawl, summaryMarkdown, type Env } from '../../src/catalog/crawl.ts';
import { checkItem, loadVocab } from '../../src/catalog/item.ts';
import { MAX_NEW_PER_RUN } from '../../src/catalog/limits.ts';
import { BadPackage, sri512 } from '../../src/catalog/pkg.ts';
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

// seed를 한 뒤의 mcp 목록: 기준 시각이 있어야 crawl이 Registry를 본다.
const SINCE = '2026-10-15T03:17:00.000Z';
const PAGE = `${R}?limit=100&version=latest&updated_since=${encodeURIComponent(SINCE)}`;
function mcpRoot() {
  const root = catalogRoot();
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state', 'mcp.json'), JSON.stringify({ since: SINCE, seen: {} }));
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
function fakeAsk(calls: string[], chips: string[] = []): Ask {
  return async (system) => {
    if (system.includes('보안 검토자')) {
      calls.push('review');
      return { ok: true, json: {
        verdict: 'ok', rw: 'R', tools: [{ name: 'get_issue', rw: 'R' }, { name: 'create_pr', rw: 'W' }],
        findings: [{ file: 'package/index.js', line: 1, kind: 'ok_evidence', note: 'registers tools only' }], summary: 'GitHub 이슈 읽기, PR 올리기',
      } };
    }
    calls.push('tag');
    return { ok: true, json: { task: ['bugfix'], stage: ['plan', 'implement'], capability: ['github'], needs_shell: false, windows: 'unknown', new_chips: chips } };
  };
}

function mcpRoutes(servers: { name: string; stars: number }[], tgz: Buffer) {
  const routes: Record<string, unknown> = {
    [PAGE]: { servers: servers.map(({ name }) => ({
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
    const root = mcpRoot();
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
    routes[`${R}?limit=100&version=latest&updated_since=2026-10-16T03%3A17%3A00.000Z`] = routes[PAGE];
    const again = await crawl('mcp', { ...env(root, routes, calls), now: new Date('2026-10-17T03:17:00Z') });
    expect([again.added, again.updated, again.dropped]).toEqual([[], [], []]);
    expect(calls).toHaveLength(2);
  });

  it('drops a server whose GitHub repository is gone, and stops at the first rate limit without moving `since`', async () => {
    const root = mcpRoot();
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
    expect(JSON.parse(readFileSync(join(root, 'state', 'mcp.json'), 'utf8')).since).toBe(SINCE);
  });

  it('drops (not errors) a server whose npm package is gone or whose dependencies cannot be resolved', async () => {
    const root = mcpRoot();
    const routes = mcpRoutes([{ name: 'io.github.acme/gone', stars: 300 }, { name: 'io.github.acme/tangle', stars: 300 }], tarball());
    delete routes['https://registry.npmjs.org/@acme/gone/1.0.0'];
    const lock = (id: string) => { if (id === '@acme/tangle') throw new BadPackage('npm error code ERESOLVE'); return []; };
    const s = await crawl('mcp', { ...env(root, routes, []), lock });
    expect(s.dropped.map((n) => n.reasons[0])).toEqual(['npm @acme/gone@1.0.0 not found', 'npm error code ERESOLVE']);
    expect(s.errors).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, 'state', 'mcp.json'), 'utf8')).since).toBe(NOW.toISOString());
  });

  it('treats a transient dependency-resolution failure as an error, not a drop, and holds `since`', async () => {
    const root = mcpRoot();
    const routes = mcpRoutes([{ name: 'io.github.acme/gh', stars: 300 }], tarball());
    const lock = () => { throw new Error('Command failed: npm install\nnpm error code ECONNRESET'); };
    const s = await crawl('mcp', { ...env(root, routes, []), lock });
    expect(s.errors.map((n) => n.id)).toEqual(['io-github-acme-gh']);
    expect(s.dropped).toEqual([]);
    const state = JSON.parse(readFileSync(join(root, 'state', 'mcp.json'), 'utf8'));
    expect(state.since).toBe(SINCE);
    expect(state.seen).toEqual({});
  });

  it('drops a package whose tarball fails its integrity check instead of blocking `since` forever', async () => {
    const root = mcpRoot();
    const routes = mcpRoutes([{ name: 'io.github.acme/gh', stars: 300 }], tarball());
    routes['https://registry.npmjs.org/@acme/gh/1.0.0'] = { dist: { integrity: I, tarball: 'https://r.example/p.tgz' } };
    const s = await crawl('mcp', env(root, routes, []));
    expect(s.dropped.map((n) => n.reasons[0])).toEqual(['integrity mismatch for https://r.example/p.tgz']);
    expect(s.errors).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, 'state', 'mcp.json'), 'utf8')).since).toBe(NOW.toISOString());
  });

  it('withdraws an active server the registry now lists as deleted, even at the same version', async () => {
    const root = mcpRoot();
    const routes = mcpRoutes([{ name: 'io.github.acme/gh', stars: 300 }], tarball());
    await crawl('mcp', env(root, routes, []));
    const page = routes[PAGE] as { servers: { _meta: Record<string, { status: string }> }[] };
    page.servers[0]._meta['io.modelcontextprotocol.registry/official'].status = 'deleted';
    routes[`${R}?limit=100&version=latest&updated_since=2026-10-16T03%3A17%3A00.000Z`] = page;
    const s = await crawl('mcp', { ...env(root, routes, []), now: new Date('2026-10-17T03:17:00Z') });
    expect(s.withdrawn).toEqual(['io-github-acme-gh']);
    expect(s.updated).toEqual([]);
    expect(summaryMarkdown(s, '2026-10-17')).toContain('- 내림(withdrawn) 1: `io-github-acme-gh`');
    expect(JSON.parse(readFileSync(join(root, 'items', 'mcp', 'io-github-acme-gh.json'), 'utf8')).status).toBe('withdrawn');
  });

  it('reviews a server only once even if the registry lists it twice in one run', async () => {
    const root = mcpRoot();
    const calls: string[] = [];
    const routes = mcpRoutes([{ name: 'io.github.acme/gh', stars: 300 }], tarball());
    const page = routes[PAGE] as { servers: unknown[] };
    page.servers.push(page.servers[0]);
    const s = await crawl('mcp', env(root, routes, calls));
    expect(s.added).toEqual(['io-github-acme-gh']);
    expect(calls).toEqual(['review', 'tag']);
  });

  it('seed: looks only at the named servers and starts `since` now, so the first run does not walk the whole registry', async () => {
    const root = catalogRoot();
    const routes = mcpRoutes([{ name: 'io.github.acme/gh', stars: 300 }], tarball());
    const entry = (routes[PAGE] as { servers: unknown[] }).servers[0];
    delete routes[PAGE];
    routes[`${R}/io.github.acme%2Fgh/versions/latest`] = entry;
    const s = await crawl('mcp', env(root, routes, []), ['io.github.acme/gh', 'io.github.nobody/none']);
    expect(s.added).toEqual(['io-github-acme-gh']);
    expect(s.dropped.map((n) => n.id)).toEqual(['io-github-nobody-none']);
    expect(JSON.parse(readFileSync(join(root, 'state', 'mcp.json'), 'utf8')).since).toBe(NOW.toISOString());
  });

  it('does nothing before the seed: without `since` it writes no item or state and says to seed first', async () => {
    const root = catalogRoot();
    const { http, calls } = fakeHttp({});
    const s = await crawl('mcp', { ...env(root, {}, []), http });
    expect(calls).toEqual([]);
    expect(readdirSync(root)).toEqual(['vocab.json']);
    expect(summaryMarkdown(s, '2026-10-16')).toContain('seed mcp <이름…>');
  });

  it('does not let another registry name with the same id withdraw or overwrite an item', async () => {
    const root = mcpRoot();
    const routes = mcpRoutes([{ name: 'io.github.acme/mcp-server', stars: 300 }], tarball());
    await crawl('mcp', env(root, routes, []));
    const page = structuredClone(routes[PAGE]) as { servers: { server: { name: string }; _meta: Record<string, { status: string }> }[] };
    page.servers[0].server.name = 'io.github.acme-mcp/server';
    page.servers[0]._meta['io.modelcontextprotocol.registry/official'].status = 'deprecated';
    routes[`${R}?limit=100&version=latest&updated_since=2026-10-16T03%3A17%3A00.000Z`] = page;
    const s = await crawl('mcp', { ...env(root, routes, []), now: new Date('2026-10-17T03:17:00Z') });
    expect(s.withdrawn).toEqual([]);
    expect(s.dropped).toEqual([{ id: 'io-github-acme-mcp-server', version: '1.0.0', reasons: ['id collision with io.github.acme/mcp-server'] }]);
    expect(JSON.parse(readFileSync(join(root, 'items', 'mcp', 'io-github-acme-mcp-server.json'), 'utf8')).status).toBe('active');
    expect(JSON.parse(readFileSync(join(root, 'state', 'mcp.json'), 'utf8')).seen).toEqual({});
  });

  it('keeps the review when Scorecard fails after the Claude calls (Scorecard is optional)', async () => {
    const root = mcpRoot();
    const routes = mcpRoutes([{ name: 'io.github.acme/gh', stars: 300 }], tarball());
    const base = fakeHttp(routes).http;
    const http: typeof base = async (u, i) => (String(u).startsWith('https://api.scorecard.dev/') ? new Response('down', { status: 503 }) : base(u, i));
    const s = await crawl('mcp', { ...env(root, routes, []), http });
    expect([s.added, s.errors]).toEqual([['io-github-acme-gh'], []]);
    expect(JSON.parse(readFileSync(join(root, 'items', 'mcp', 'io-github-acme-gh.json'), 'utf8')).scorecard).toBeNull();
  });

  it('lists the new chips the tagger proposed, once each, as code spans', async () => {
    const root = mcpRoot();
    const routes = mcpRoutes([{ name: 'io.github.acme/a', stars: 300 }, { name: 'io.github.acme/b', stars: 300 }], tarball());
    const s = await crawl('mcp', { ...env(root, routes, []), ask: fakeAsk([], ['ci', 'release\n`x`']) });
    expect(s.added).toHaveLength(2);
    expect(summaryMarkdown(s, '2026-10-16')).toContain("### 새 칩 제안 2\n- `ci`\n- `release 'x'`\n");
  });

  it('stops reviewing new servers at the per-run cap and keeps `since` so the rest come next run', async () => {
    const root = mcpRoot();
    const calls: string[] = [];
    const n = MAX_NEW_PER_RUN.mcp + 2;
    const routes = mcpRoutes(Array.from({ length: n }, (_, i) => ({ name: `io.github.acme/s${i}`, stars: 300 })), tarball());
    const s = await crawl('mcp', env(root, routes, calls));
    expect(s.added).toHaveLength(MAX_NEW_PER_RUN.mcp);
    expect(s.capped).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'state', 'mcp.json'), 'utf8')).since).toBe(SINCE);
    expect(summaryMarkdown(s, '2026-10-16')).toContain('다음 실행에서 본다');
  });
});

describe('summaryMarkdown', () => {
  it('renders untrusted notes as one line inside code spans', () => {
    const s = {
      kind: 'mcp' as const, added: [], updated: [], withdrawn: [], held: [], rejected: [], dropped: [], newChips: [], capped: false,
      errors: [{ id: 'x', version: '1.0.0\n## fake', reasons: ['line one\n\n@someone see #12 `rm -rf`', 'y'.repeat(400)] }],
    };
    const line = summaryMarkdown(s, '2026-10-16').split('\n').find((l) => l.startsWith('- `x`'))!;
    expect(line).toMatch(/^- `x` `1\.0\.0 ## fake`: `line one @someone see #12 'rm -rf'; y+…`$/);
    expect(summaryMarkdown(s, '2026-10-16')).not.toContain('\n## fake');
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
    // 깨진 출처 다음 출처에 skill이 하나 있다: 거기까지 계속 본다.
    const other = 'anthropics/claude-plugins-official';
    routes[raw(other, '.claude-plugin/marketplace.json')] = { plugins: [{ name: 'y', source: './', skills: ['./skills/extra'] }] };
    routes[`${GH}/${other}/git/trees/root-${other}?recursive=1`] = { truncated: false, tree: [
      treeNode('skills'), treeNode('skills/extra'), blob('skills/extra/SKILL.md'), blob('skills/extra/LICENSE.txt'),
    ] };
    routes[raw(other, 'skills/extra/SKILL.md')] = '---\nname: extra\n---\nSummarize the diff.';
    routes[raw(other, 'skills/extra/LICENSE.txt')] = 'MIT License';
    const s = await crawl('skill', { http: fakeHttp(routes).http, ask: skillAsk([]), now: NOW, root, lock: () => [] });
    expect(s.errors.map((n) => n.id)).toEqual(['anthropics-skills']);
    expect(s.added).toEqual(['anthropics-claude-plugins-official-extra']);
    expect(s.withdrawn).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, 'items', 'skill', 'anthropics-skills-good.json'), 'utf8')).status).toBe('active');
  });

  // 바뀐 것이 없는 날에 시각만 바뀐 PR이 매일 자동 병합되지 않게, skill 상태 파일은 그대로 둔다.
  it('leaves the skill state file byte-identical on a run with no item changes', async () => {
    const root = catalogRoot();
    const run = (now: Date) => crawl('skill', { http: fakeHttp(skillRoutes()).http, ask: skillAsk([]), now, root, lock: () => [] });
    await run(NOW);
    const before = readFileSync(join(root, 'state', 'skill.json'));
    await run(new Date('2026-10-17T03:17:00Z'));
    expect(readFileSync(join(root, 'state', 'skill.json'))).toEqual(before);
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

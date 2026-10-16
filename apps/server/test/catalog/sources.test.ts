import { describe, expect, it } from 'vitest';
import { detectLicense, githubRepo, npmVersion, osv, parseGithub, registryChanges, registryServer, scorecard, skillDirs } from '../../src/catalog/sources.ts';
import { fakeHttp } from './fake.ts';

const R = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const meta = (status: string) => ({ 'io.modelcontextprotocol.registry/official': { status } });

describe('registryChanges', () => {
  it('pages with version=latest and keeps only stdio npm servers', async () => {
    const { http, calls } = fakeHttp({
      [`${R}?limit=100&version=latest&updated_since=2026-10-01T00%3A00%3A00Z`]: {
        servers: [
          { server: { name: 'io.github.a/gh', version: '1.0.0', repository: { url: 'https://github.com/a/gh' },
            packages: [{ registryType: 'npm', identifier: '@a/gh', version: '1.0.0', transport: { type: 'stdio' } }] }, _meta: meta('active') },
          { server: { name: 'com.b/remote', version: '2.0.0', remotes: [{ type: 'streamable-http', url: 'https://b' }] }, _meta: meta('active') },
          { server: { name: 'io.c/py', version: '0.1.0', packages: [{ registryType: 'pypi', identifier: 'c', version: '0.1.0', transport: { type: 'stdio' } }] } },
        ],
        metadata: { nextCursor: 'io.c/py:0.1.0' },
      },
      [`${R}?limit=100&version=latest&updated_since=2026-10-01T00%3A00%3A00Z&cursor=io.c%2Fpy%3A0.1.0`]: {
        servers: [{ server: { name: 'io.github.d/old', version: '3.0.0',
          packages: [{ registryType: 'npm', identifier: 'd-mcp', version: '3.0.0', transport: { type: 'stdio' } }] }, _meta: meta('deprecated') }],
        metadata: {},
      },
    });
    const got = await registryChanges(http, '2026-10-01T00:00:00Z');
    expect(calls).toHaveLength(2);
    expect(got).toEqual([
      { name: 'io.github.a/gh', version: '1.0.0', status: 'active', npm: { id: '@a/gh', version: '1.0.0' },
        repo: 'https://github.com/a/gh', source: `${R}/io.github.a%2Fgh/versions/1.0.0` },
      { name: 'io.github.d/old', version: '3.0.0', status: 'deprecated', npm: { id: 'd-mcp', version: '3.0.0' },
        repo: null, source: `${R}/io.github.d%2Fold/versions/3.0.0` },
    ]);
  });
});

describe('registryServer and npmVersion', () => {
  it('return null for names that do not exist', async () => {
    const { http } = fakeHttp({});
    expect(await registryServer(http, 'io.github.x/none')).toBeNull();
    expect(await npmVersion(http, '@x/none', '1.0.0')).toBeNull();
  });
});

describe('GitHub', () => {
  it('parses the usual repository URL shapes', () => {
    expect(parseGithub('git+https://github.com/o/r.git')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGithub('https://github.com/o/r/tree/main/src/x')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGithub('git@github.com:o/r.git')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGithub('https://gitlab.com/o/r')).toBeNull();
    expect(parseGithub(null)).toBeNull();
  });

  it('treats NOASSERTION as no license', async () => {
    const { http } = fakeHttp({ 'https://api.github.com/repos/o/r': {
      stargazers_count: 7, forks_count: 1, archived: false, pushed_at: '2026-10-01T00:00:00Z',
      license: { spdx_id: 'NOASSERTION' }, default_branch: 'main' } });
    expect((await githubRepo(http, 'o', 'r'))?.license).toBeNull();
  });

  it('returns null for a repository that does not exist and throws on rate limits', async () => {
    expect(await githubRepo(fakeHttp({}).http, 'o', 'gone')).toBeNull();
    const limited = async () => new Response('rate limited', { status: 403 });
    await expect(githubRepo(limited, 'o', 'r')).rejects.toThrow('403 https://api.github.com/repos/o/r');
  });

  it('returns null when Scorecard has no data (404)', async () => {
    const { http } = fakeHttp({});
    expect(await scorecard(http, 'o', 'r')).toBeNull();
  });
});

describe('osv', () => {
  it('flattens vulnerabilities per dependency', async () => {
    const { http, calls } = fakeHttp({ 'https://api.osv.dev/v1/querybatch': { results: [{ vulns: [{ id: 'GHSA-1' }] }, {}] } });
    expect(await osv(http, [{ name: 'lodash', version: '4.17.15' }, { name: 'zod', version: '3.0.0' }])).toEqual(['lodash@4.17.15:GHSA-1']);
    expect(JSON.parse(calls[0].body!).queries[1]).toEqual({ package: { name: 'zod', ecosystem: 'npm' }, version: '3.0.0' });
  });
});

describe('skillDirs', () => {
  const GH = 'https://api.github.com/repos/o/m';
  const tree = (paths: string[]) => paths.map((path) => ({ path, type: /(\.\w+|LICENSE)$/.test(path) ? 'blob' : 'tree', sha: `sha:${path}`, size: 10 }));
  const routes = {
    [GH]: { default_branch: 'main' },
    [`${GH}/branches/main`]: { commit: { sha: 'c'.repeat(40), commit: { tree: { sha: 'root' } } } },
    [`${GH}/git/trees/root?recursive=1`]: { truncated: false, tree: tree([
      'skills', 'skills/a', 'skills/a/SKILL.md', 'skills/a/LICENSE.txt', 'skills/a/ref.md',
      'plugins', 'plugins/p', 'plugins/p/LICENSE', 'plugins/p/skills', 'plugins/p/skills/b', 'plugins/p/skills/b/SKILL.md',
      'plugins/p/skills/b/deep', 'plugins/p/skills/b/deep/SKILL.md',
      'plugins/withmcp', 'plugins/withmcp/.mcp.json', 'plugins/withmcp/skills', 'plugins/withmcp/skills/c', 'plugins/withmcp/skills/c/SKILL.md',
    ]) },
    [`https://raw.githubusercontent.com/o/m/${'c'.repeat(40)}/.claude-plugin/marketplace.json`]: { plugins: [
      { name: 'docs', source: './', skills: ['./skills/a'] },
      { name: 'p', source: './plugins/p' },
      { name: 'withmcp', source: './plugins/withmcp' },
      { name: 'remote', source: { source: 'url', url: 'https://github.com/x/y.git' } },
    ] },
  };

  it('lists in-repo skills, skips plugins with MCP or other repos, and finds license files', async () => {
    const { http } = fakeHttp(routes);
    const got = await skillDirs(http, 'o/m');
    expect(got.map((s) => s.dir)).toEqual(['skills/a', 'plugins/p/skills/b']);
    expect(got[0]).toMatchObject({ name: 'a', treeSha: 'sha:skills/a', licenseFiles: ['skills/a/LICENSE.txt'] });
    expect(got[0].files.map((f) => f.path)).toEqual(['skills/a/SKILL.md', 'skills/a/LICENSE.txt', 'skills/a/ref.md']);
    expect(got[1].licenseFiles).toEqual(['plugins/p/LICENSE']);
  });
});

describe('detectLicense', () => {
  it('names common open licenses and refuses the rest', () => {
    expect(detectLicense('\n   Apache License\n   Version 2.0, January 2004')).toBe('Apache-2.0');
    expect(detectLicense('MIT License\n\nPermission is hereby granted, free of charge')).toBe('MIT');
    expect(detectLicense('© 2025 Anthropic, PBC. All rights reserved.')).toBeNull();
  });
});

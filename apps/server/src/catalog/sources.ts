// 출처에서 사실을 가져온다(설계 3·4.2절). 네트워크는 인자로 받은 http로만 해서 시험에서 녹화 응답으로 바꾼다.
export type Http = typeof fetch;

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const GH = 'https://api.github.com';

async function json<T>(http: Http, url: string, init?: RequestInit): Promise<T> {
  const r = await http(url, init);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return (await r.json()) as T;
}

const ghHeaders = (token?: string): HeadersInit => ({
  accept: 'application/vnd.github+json',
  'user-agent': 'cubespace-catalog',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

// ---------- MCP Registry ----------
export interface McpCandidate {
  name: string;
  version: string;
  status: string;
  npm: { id: string; version: string };
  repo: string | null;
  source: string;
}

interface RegistryEntry {
  server: {
    name: string;
    version: string;
    repository?: { url?: string };
    packages?: { registryType?: string; identifier?: string; version?: string; transport?: { type?: string } }[];
  };
  _meta?: Record<string, { status?: string } | undefined>;
}

function candidateOf({ server: s, _meta }: RegistryEntry): McpCandidate | null {
  const npm = s.packages?.find((p) => p.registryType === 'npm' && p.transport?.type === 'stdio' && p.identifier && p.version);
  if (!npm) return null;
  return {
    name: s.name,
    version: s.version,
    status: _meta?.['io.modelcontextprotocol.registry/official']?.status ?? 'unknown',
    npm: { id: npm.identifier!, version: npm.version! },
    repo: s.repository?.url ?? null,
    source: `${REGISTRY}/${encodeURIComponent(s.name)}/versions/${encodeURIComponent(s.version)}`,
  };
}

// 팀이 고른 첫 판 항목(설계 4.1절). 없거나 stdio npm이 아니면 null.
export async function registryServer(http: Http, name: string): Promise<McpCandidate | null> {
  const r = await http(`${REGISTRY}/${encodeURIComponent(name)}/versions/latest`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${r.status} registry ${name}`);
  return candidateOf((await r.json()) as RegistryEntry);
}

// 바뀐 서버의 최신 판만 받고(version=latest), stdio npm 패키지가 있는 것만 남긴다(설계 4.6절).
export async function registryChanges(http: Http, since: string | null): Promise<McpCandidate[]> {
  const out: McpCandidate[] = [];
  let cursor: string | undefined;
  do {
    const q = new URLSearchParams({ limit: '100', version: 'latest' });
    if (since) q.set('updated_since', since);
    if (cursor) q.set('cursor', cursor);
    const page = await json<{ servers: RegistryEntry[]; metadata?: { nextCursor?: string } }>(http, `${REGISTRY}?${q}`);
    for (const e of page.servers) {
      const c = candidateOf(e);
      if (c) out.push(c);
    }
    cursor = page.metadata?.nextCursor;
  } while (cursor);
  return out;
}

// ---------- npm ----------
// 그 판이 npm에 없으면 null(= 기준 미달). 오류로 두면 기준 시각이 넘어가지 않는다.
export async function npmVersion(http: Http, id: string, version: string) {
  const r = await http(`https://registry.npmjs.org/${id}/${version}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${r.status} https://registry.npmjs.org/${id}/${version}`);
  const v = (await r.json()) as { dist: { integrity: string; tarball: string }; repository?: { url?: string } | string };
  const repo = typeof v.repository === 'string' ? v.repository : v.repository?.url ?? null;
  return { integrity: v.dist.integrity, tarball: v.dist.tarball, repo };
}

// ---------- GitHub ----------
export function parseGithub(url: string | null): { owner: string; repo: string } | null {
  const m = url?.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, '') } : null;
}

export interface RepoFacts { stars: number; forks: number; archived: boolean; pushedAt: string; license: string | null; defaultBranch: string }

// 저장소가 없으면(404) null. 한도·서버 오류는 던져서 다음 실행에서 다시 보게 한다.
export async function githubRepo(http: Http, owner: string, repo: string, token?: string): Promise<RepoFacts | null> {
  const r = await http(`${GH}/repos/${owner}/${repo}`, { headers: ghHeaders(token) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${r.status} ${GH}/repos/${owner}/${repo}`);
  const d = (await r.json()) as {
    stargazers_count: number; forks_count: number; archived: boolean; pushed_at: string;
    license: { spdx_id?: string } | null; default_branch: string;
  };
  const spdx = d.license?.spdx_id;
  return {
    stars: d.stargazers_count, forks: d.forks_count, archived: d.archived, pushedAt: d.pushed_at,
    license: spdx && spdx !== 'NOASSERTION' ? spdx : null, defaultBranch: d.default_branch,
  };
}

// 점수가 없는 저장소는 404다. 점수가 없다고 빼지 않는다(4.2절).
export async function scorecard(http: Http, owner: string, repo: string): Promise<number | null> {
  const r = await http(`https://api.scorecard.dev/projects/github.com/${owner}/${repo}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${r.status} scorecard ${owner}/${repo}`);
  return ((await r.json()) as { score?: number }).score ?? null;
}

// ---------- OSV ----------
export async function osv(http: Http, deps: { name: string; version: string }[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < deps.length; i += 1000) {
    const queries = deps.slice(i, i + 1000).map((d) => ({ package: { name: d.name, ecosystem: 'npm' }, version: d.version }));
    const res = await json<{ results: { vulns?: { id: string }[] }[] }>(http, 'https://api.osv.dev/v1/querybatch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries }),
    });
    res.results.forEach((r, j) => r.vulns?.forEach((v) => ids.push(`${deps[i + j].name}@${deps[i + j].version}:${v.id}`)));
  }
  return ids;
}

// ---------- skills (Anthropic 마켓플레이스) ----------
export const SKILL_REPOS = ['anthropics/skills', 'anthropics/claude-plugins-official'];

export interface SkillDir {
  repo: string; // owner/name
  commit: string;
  dir: string; // 저장소 안 경로
  name: string;
  treeSha: string; // 폴더의 git tree sha. 바뀌면 새 판
  files: { path: string; size: number }[];
  licenseFiles: string[]; // skill 폴더, 그다음 플러그인 뿌리의 LICENSE*
}

interface TreeEntry { path: string; type: 'blob' | 'tree'; sha: string; size?: number }
type Plugin = { name: string; source: unknown; skills?: string[] };

const clean = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '').replace(/^\.$/, '');
const join = (a: string, b: string) => [clean(a), clean(b)].filter(Boolean).join('/');
const licenseIn = (tree: TreeEntry[], dir: string) => {
  const pre = dir ? dir + '/' : '';
  return tree.filter((e) => e.type === 'blob' && e.path.startsWith(pre) && /^LICEN[CS]E(\.(txt|md))?$/i.test(e.path.slice(pre.length)))
    .map((e) => e.path);
};

// 같은 저장소 안(문자열 source)에 있는 플러그인의 skill만 받는다. 다른 저장소를 가리키는 플러그인,
// MCP(.mcp.json)나 훅(hooks/)이 든 플러그인은 설계 14절(plugin 처리)이 정해질 때까지 받지 않는다.
export async function skillDirs(http: Http, repo: string, token?: string): Promise<SkillDir[]> {
  const h = { headers: ghHeaders(token) };
  const { default_branch } = await json<{ default_branch: string }>(http, `${GH}/repos/${repo}`, h);
  const br = await json<{ commit: { sha: string; commit: { tree: { sha: string } } } }>(http, `${GH}/repos/${repo}/branches/${default_branch}`, h);
  const commit = br.commit.sha;
  const t = await json<{ tree: TreeEntry[]; truncated: boolean }>(http, `${GH}/repos/${repo}/git/trees/${br.commit.commit.tree.sha}?recursive=1`, h);
  if (t.truncated) throw new Error(`tree truncated for ${repo}`);
  const has = (p: string) => t.tree.some((e) => e.path === p || e.path.startsWith(p + '/'));
  const mk = await json<{ plugins: Plugin[] }>(http, `https://raw.githubusercontent.com/${repo}/${commit}/.claude-plugin/marketplace.json`);

  const out = new Map<string, SkillDir>();
  for (const p of mk.plugins) {
    if (typeof p.source !== 'string') continue;
    const root = clean(p.source);
    if (has(join(root, '.mcp.json')) || has(join(root, 'hooks'))) continue;
    const base = join(root, 'skills') + '/';
    const dirs = p.skills
      ? p.skills.map((s) => join(root, s))
      : t.tree.filter((e) => e.path.startsWith(base) && e.path.endsWith('/SKILL.md') && e.path.slice(base.length).split('/').length === 2)
          .map((e) => e.path.slice(0, -'/SKILL.md'.length));
    for (const dir of dirs) {
      const node = t.tree.find((e) => e.path === dir && e.type === 'tree');
      if (!node || !has(`${dir}/SKILL.md`) || out.has(dir)) continue;
      out.set(dir, {
        repo, commit, dir, name: dir.split('/').pop()!, treeSha: node.sha,
        files: t.tree.filter((e) => e.type === 'blob' && e.path.startsWith(dir + '/')).map((e) => ({ path: e.path, size: e.size ?? 0 })),
        licenseFiles: [...licenseIn(t.tree, dir), ...licenseIn(t.tree, root)],
      });
    }
  }
  return [...out.values()];
}

export async function rawText(http: Http, repo: string, commit: string, path: string): Promise<string> {
  const r = await http(`https://raw.githubusercontent.com/${repo}/${commit}/${path}`);
  if (!r.ok) throw new Error(`${r.status} ${repo}/${path}`);
  return r.text();
}

// LICENSE 파일 본문에서 SPDX 이름을 고른다. 모르면 null(= 4.2절에서 빠진다).
export function detectLicense(text: string): string | null {
  if (/Apache License\s+Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/\bMIT License\b|Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/Redistribution and use in source and binary forms/i.test(text)) return /Neither the name/i.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (/ISC License|Permission to use, copy, modify, and\/or distribute this software/i.test(text)) return 'ISC';
  return null;
}

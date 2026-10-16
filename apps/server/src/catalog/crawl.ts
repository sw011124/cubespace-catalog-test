// 하루 한 번 도는 목록 갱신(설계 4.1절). 종류(mcp, skill)마다 자기 파일만 쓴다:
// catalog/items/<kind>/*.json, catalog/state/<kind>.json. 그래서 두 PR이 서로 부딪히지 않는다.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { gate, type Facts } from './checks.ts';
import { idFor, loadVocab, type Dep, type Item, type Kind } from './item.ts';
import { MAX_NEW_PER_RUN, SKILL_TEXT_EXT } from './limits.ts';
import { BadPackage, extractTarball, fetchTarball, reviewFiles, sha256 } from './pkg.ts';
import { reviewItem, tagItem, type Ask, type ReviewFile } from './review.ts';
import {
  detectLicense, githubRepo, npmVersion, osv, parseGithub, rawText, registryChanges, registryServer, scorecard, SKILL_REPOS, skillDirs,
  type Http, type McpCandidate, type RepoFacts, type SkillDir,
} from './sources.ts';

export interface Env {
  http: Http;
  ask: Ask;
  now: Date;
  root: string; // apps/server/catalog
  token?: string;
  lock: (id: string, version: string) => Dep[];
}

type Decision = 'drop' | 'human' | 'reject' | 'warn';
interface State { since: string | null; seen: Record<string, { version: string; decision: Decision; reasons: string[] }> }
export interface Note { id: string; version: string; reasons: string[] }
export interface Summary {
  kind: Kind; added: string[]; updated: string[]; withdrawn: string[];
  held: Note[]; rejected: Note[]; dropped: Note[]; errors: Note[]; capped: boolean;
}

const NOTE_MAX = 300;
const SCRIPT_EXT = ['.py', '.sh', '.bash', '.js', '.mjs', '.cjs', '.ts', '.ps1', '.bat', '.cmd', '.rb', '.pl'];

const readJson = <T>(p: string, fallback: T): T => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

function loadItems(root: string, kind: Kind): Map<string, Item> {
  const dir = join(root, 'items', kind);
  mkdirSync(dir, { recursive: true });
  return new Map(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const it = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Item;
    return [it.id, it];
  }));
}

const noteOf = (id: string, version: string, reasons: string[]): Note => ({ id, version, reasons });

// seeds가 있으면(mcp만) 기준 시각과 상관없이 그 서버들만 보고, 기준 시각이 비어 있으면 지금으로 정한다.
// 첫 실행을 seed로 하지 않으면 Registry 전체를 처음부터 알파벳 순으로 검토하게 된다.
export async function crawl(kind: Kind, env: Env, seeds?: string[]): Promise<Summary> {
  const statePath = join(env.root, 'state', `${kind}.json`);
  mkdirSync(join(env.root, 'state'), { recursive: true });
  const state = readJson<State>(statePath, { since: null, seen: {} });
  const items = loadItems(env.root, kind);
  const s: Summary = { kind, added: [], updated: [], withdrawn: [], held: [], rejected: [], dropped: [], errors: [], capped: false };
  const startedAt = env.now.toISOString();
  let reviewsOfNew = 0;

  const save = (it: Item, isNew: boolean) => {
    writeJson(join(env.root, 'items', kind, `${it.id}.json`), it);
    items.set(it.id, it); // 같은 실행에서 같은 판이 또 나오면 건너뛴다
    (isNew ? s.added : s.updated).push(it.id);
  };
  const remember = (id: string, version: string, decision: Decision, reasons: string[]) => {
    state.seen[id] = { version, decision, reasons };
    const n = noteOf(id, version, reasons);
    ({ drop: s.dropped, human: s.held, warn: s.held, reject: s.rejected })[decision].push(n);
  };
  const withdraw = (it: Item) => {
    writeJson(join(env.root, 'items', kind, `${it.id}.json`), { ...it, status: 'withdrawn', updated_at: startedAt });
    items.set(it.id, { ...it, status: 'withdrawn', updated_at: startedAt });
    s.withdrawn.push(it.id);
  };
  // 새 항목의 Claude 검토 횟수 상한(설계 4.1절 5). 넘으면 다음 실행으로 넘긴다.
  const mayReview = (isNew: boolean) => {
    if (!isNew) return true;
    if (reviewsOfNew >= MAX_NEW_PER_RUN[kind]) { s.capped = true; return false; }
    reviewsOfNew++;
    return true;
  };

  const vocab = loadVocab(join(env.root, 'vocab.json'));
  const base = { now: env.now, vocab, save, remember, withdraw, mayReview, items, env };

  if (kind === 'mcp') {
    let cands: McpCandidate[] = [];
    if (!seeds) cands = await registryChanges(env.http, state.since);
    else for (const n of seeds) {
      const c = await registryServer(env.http, n);
      if (c) cands.push(c);
      else s.dropped.push(noteOf(idFor(n), '-', ['not a stdio npm server in the registry']));
    }
    for (const c of cands) {
      const id = idFor(c.name);
      const cur = items.get(id);
      // Registry에서 deleted·deprecated가 되면 판이 그대로여도 내린다(설계 4.2절). 같은 판 건너뛰기보다 먼저 본다.
      if (cur?.status === 'active' && (c.status === 'deleted' || c.status === 'deprecated')) { withdraw(cur); continue; }
      if (cur?.version === c.version || state.seen[id]?.version === c.version) continue;
      try {
        await mcpOne(base, c, id, cur);
      } catch (e) {
        const msg = (e as Error).message;
        // 패키지 자체가 기준에 못 미치면 다시 봐도 같으니 기준 미달로 남긴다. 그 밖의 오류만 기준 시각을 멈춘다.
        if (e instanceof BadPackage) { remember(id, c.version, 'drop', [msg]); continue; }
        s.errors.push(noteOf(id, c.version, [msg]));
        if (/^(403|429) /.test(msg)) break; // 한도에 걸리면 남은 것은 다음 실행으로
      }
    }
    // 다 보지 못했으면(상한·오류) 기준 시각을 그대로 둬서 다음 실행이 다시 본다.
    if (seeds) state.since ??= startedAt;
    else if (!s.capped && !s.errors.length) state.since = startedAt;
  } else {
    const found = new Set<string>();
    for (const repo of SKILL_REPOS) {
      // 출처 하나가 깨져도 다른 출처는 계속 본다. 깨진 출처의 항목은 내리지 않는다.
      let repoFacts, dirs;
      try {
        repoFacts = await githubRepo(env.http, ...(repo.split('/') as [string, string]), env.token);
        if (!repoFacts) throw new Error(`skill source ${repo} not found`);
        dirs = await skillDirs(env.http, repo, env.token);
      } catch (e) {
        s.errors.push(noteOf(idFor(repo), '-', [(e as Error).message]));
        for (const it of items.values()) if (it.source.startsWith(`https://github.com/${repo}/`)) found.add(it.id);
        continue;
      }
      for (const d of dirs) {
        // 경로의 plugins/·skills/ 마디는 빼서 id를 줄인다: anthropics/skills + skills/pdf → anthropics-skills-pdf
        const id = idFor(`${repo}/${d.dir.replace(/(^|\/)(plugins|skills)\//g, '$1')}`);
        found.add(id);
        const cur = items.get(id);
        if (cur?.version === d.treeSha || state.seen[id]?.version === d.treeSha) continue;
        try {
          await skillOne(base, repo, repoFacts, d, id, cur);
        } catch (e) {
          s.errors.push(noteOf(id, d.treeSha, [(e as Error).message]));
        }
      }
    }
    for (const it of [...items.values()]) if (it.status === 'active' && !found.has(it.id)) withdraw(it);
    state.since = startedAt;
  }
  writeJson(statePath, state);
  return s;
}

type Base = {
  now: Date; vocab: ReturnType<typeof loadVocab>; env: Env; items: Map<string, Item>;
  save: (it: Item, isNew: boolean) => void;
  withdraw: (it: Item) => void;
  remember: (id: string, version: string, d: Decision, reasons: string[]) => void;
  mayReview: (isNew: boolean) => boolean;
};

async function mcpOne(b: Base, c: McpCandidate, id: string, cur: Item | undefined) {
  const { env } = b;
  const at = env.now.toISOString();
  if (c.status === 'deleted' || c.status === 'deprecated') {
    if (cur?.status === 'active') b.withdraw(cur);
    else if (!cur) b.remember(id, c.version, 'drop', [`registry status ${c.status}`]);
    return;
  }
  const npm = await npmVersion(env.http, c.npm.id, c.npm.version);
  if (!npm) return b.remember(id, c.version, 'drop', [`npm ${c.npm.id}@${c.npm.version} not found`]);
  const gh = parseGithub(c.repo) ?? parseGithub(npm.repo);
  if (!gh) return b.remember(id, c.version, 'drop', ['no GitHub repository']);
  const repo = await githubRepo(env.http, gh.owner, gh.repo, env.token);
  if (!repo) return b.remember(id, c.version, 'drop', [`GitHub repository ${gh.owner}/${gh.repo} not found`]);
  const deps = env.lock(c.npm.id, c.npm.version); // 못 푸는 패키지는 BadPackage로 던져진다
  const vulns = await osv(env.http, [{ name: c.npm.id, version: c.npm.version }, ...deps]);
  const tgz = await fetchTarball(env.http, npm.tarball, npm.integrity);
  const dir = mkdtempSync(join(tmpdir(), 'catalog-pkg-'));
  try {
    extractTarball(tgz, dir);
    const files = reviewFiles(dir);
    const facts: Facts = {
      registryStatus: c.status, archived: repo.archived, stars: repo.stars, pushedAt: repo.pushedAt, license: repo.license,
      vulns, depCount: deps.length, reviewChars: files.reduce((n, f) => n + f.text.length, 0), scriptFiles: [], skillTextBytes: 0,
    };
    const g = gate(facts, env.now);
    if (g.kind !== 'pass') return b.remember(id, c.version, g.kind, g.reasons);
    if (!b.mayReview(!cur)) return;
    const review = await reviewItem(env.ask, 'mcp', files);
    if (review.verdict === 'reject') return b.remember(id, c.version, 'reject', [review.summary]);
    if (review.tools.length === 0) return b.remember(id, c.version, 'warn', [review.summary]);
    const tags = await tagItem(env.ask, b.vocab, 'mcp', files);
    b.save({
      id, kind: 'mcp', name: c.name, version: c.version, sha256: sha256(tgz), source: c.source, updated_at: at,
      commit: null, package: { type: 'npm', id: c.npm.id, version: c.npm.version, integrity: npm.integrity, deps },
      stars: repo.stars, forks: repo.forks, license: repo.license!, scorecard: await scorecard(env.http, gh.owner, gh.repo),
      verified_at: at, tags: { task: tags.task, stage: tags.stage, capability: tags.capability, needs_shell: tags.needs_shell, windows: tags.windows },
      rw: review.rw, tools: review.tools, review: { verdict: review.verdict, summary: review.summary },
      approval: 'team', status: 'active',
    }, !cur);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function skillOne(b: Base, repo: string, rf: RepoFacts, d: SkillDir, id: string, cur: Item | undefined) {
  const { env } = b;
  const at = env.now.toISOString();
  const lic = d.licenseFiles[0] ? detectLicense(await rawText(env.http, repo, d.commit, d.licenseFiles[0])) : rf.license;
  const scripts = d.files.filter((f) => SCRIPT_EXT.includes(extname(f.path))).map((f) => f.path.slice(d.dir.length + 1));
  const textPaths = d.files.filter((f) => SKILL_TEXT_EXT.includes(extname(f.path)) && !d.licenseFiles.includes(f.path)).map((f) => f.path);
  const files: ReviewFile[] = [];
  for (const p of textPaths) files.push({ path: p.slice(d.dir.length + 1), text: await rawText(env.http, repo, d.commit, p) });
  const facts: Facts = {
    registryStatus: null, archived: rf.archived, stars: rf.stars, pushedAt: rf.pushedAt, license: lic, vulns: [], depCount: 0,
    reviewChars: files.reduce((n, f) => n + f.text.length, 0), scriptFiles: scripts,
    skillTextBytes: files.reduce((n, f) => n + Buffer.byteLength(f.text), 0),
  };
  const g = gate(facts, env.now);
  if (g.kind !== 'pass') return b.remember(id, d.treeSha, g.kind, g.reasons);
  if (!b.mayReview(!cur)) return;
  const review = await reviewItem(env.ask, 'skill', files);
  // 자동 승인은 ok인 skill만(설계 4.5절). warn은 PR 본문에 남기고 사람이 따로 올린다.
  if (review.verdict !== 'ok') return b.remember(id, d.treeSha, review.verdict, [review.summary]);
  const tags = await tagItem(env.ask, b.vocab, 'skill', files);
  b.save({
    id, kind: 'skill', name: d.name, version: d.treeSha,
    sha256: sha256(files.map((f) => `${f.path}\0${f.text}`).join('\0')),
    source: `https://github.com/${repo}/tree/${d.commit}/${d.dir}`, updated_at: at, commit: d.commit, package: null,
    stars: rf.stars, forks: rf.forks, license: lic!, scorecard: null, verified_at: at,
    tags: { task: tags.task, stage: tags.stage, capability: tags.capability, needs_shell: tags.needs_shell, windows: tags.windows },
    rw: review.rw, tools: [], review: { verdict: review.verdict, summary: review.summary }, approval: 'auto', status: 'active',
  }, !cur);
}

export function summaryMarkdown(s: Summary, date: string): string {
  // 이유·판에는 Claude 답, 오류 문구, Registry가 정한 글이 들어온다. 한 줄로 접고 코드 조각에 넣어 PR 본문을 깨거나 사람을 부르지 못하게 한다.
  const code = (t: string) => {
    const one = t.replace(/\s+/g, ' ').replace(/`/g, "'").trim();
    return `\`${one.length > NOTE_MAX ? one.slice(0, NOTE_MAX) + '…' : one}\``;
  };
  const list = (title: string, notes: Note[], max = 30) => notes.length
    ? [`### ${title} ${notes.length}`, ...notes.slice(0, max).map((n) => `- \`${n.id}\` ${code(n.version)}: ${code(n.reasons.join('; '))}`),
       ...(notes.length > max ? [`- …그 밖에 ${notes.length - max}개`] : []), '']
    : [];
  return [
    `## catalog(${s.kind}) ${date}`, '',
    `- 추가 ${s.added.length}${s.added.length ? ': ' + s.added.map((i) => `\`${i}\``).join(', ') : ''}`,
    `- 갱신 ${s.updated.length}${s.updated.length ? ': ' + s.updated.map((i) => `\`${i}\``).join(', ') : ''}`,
    `- 내림(withdrawn) ${s.withdrawn.length}`,
    ...(s.capped ? ['- 새 항목 검토 상한에 걸려 남은 것은 다음 실행에서 본다'] : []),
    '',
    ...list('사람 확인 필요', s.held),
    ...list('거절', s.rejected),
    ...list('오류(다음 실행에서 다시 본다)', s.errors),
    ...list('기준 미달', s.dropped, 20),
    '"검증됨"은 기준을 통과했다는 뜻이지 안전 보증이 아니다(설계 11절).',
  ].join('\n') + '\n';
}

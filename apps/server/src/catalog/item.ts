import { readFileSync } from 'node:fs';

export type Kind = 'skill' | 'mcp';
export type RW = 'R' | 'W';
export type Verdict = 'reject' | 'warn' | 'ok';

export interface Vocab { task: string[]; stack: string[]; capability: string[]; stage: string[] }
export interface Tool { name: string; rw: RW }
export interface Dep { name: string; version: string; integrity: string }
export interface Tags {
  task: string[];
  stage: string[];
  capability: string[];
  needs_shell: boolean;
  windows: 'yes' | 'no' | 'unknown';
}

// 설계 4.8절. 01 구성 2.1절 extensions 표(id, kind, name, version, sha256, source, updated_at)에 더한 것.
export interface Item {
  id: string;
  kind: Kind;
  name: string;
  version: string;
  sha256: string;
  source: string;
  updated_at: string;
  commit: string | null;
  package: { type: 'npm'; id: string; version: string; integrity: string; deps: Dep[] } | null;
  stars: number;
  forks: number;
  license: string;
  scorecard: number | null;
  verified_at: string;
  tags: Tags;
  rw: RW;
  tools: Tool[];
  review: { verdict: Verdict; summary: string };
  approval: 'auto' | 'team';
  status: 'active' | 'superseded' | 'withdrawn';
}

export const loadVocab = (path: string): Vocab => JSON.parse(readFileSync(path, 'utf8'));

export function idFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const SHA256 = /^[0-9a-f]{64}$/;
const SRI512 = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

// 목록 파일 하나가 형식에 맞는지. 빈 배열이면 통과.
export function checkItem(raw: unknown, vocab: Vocab): string[] {
  const x = (raw ?? {}) as Partial<Item>;
  const e: string[] = [];
  const need = (ok: boolean, msg: string) => { if (!ok) e.push(msg); };
  need(typeof x.id === 'string' && x.id === idFor(x.id), 'id must be lowercase [a-z0-9-]');
  need(x.kind === 'skill' || x.kind === 'mcp', 'kind');
  need(typeof x.name === 'string' && x.name.length > 0, 'name');
  need(typeof x.version === 'string' && x.version.length > 0, 'version');
  need(SHA256.test(x.sha256 ?? ''), 'sha256');
  need(/^https:\/\//.test(x.source ?? ''), 'source must be https URL');
  need(x.rw === 'R' || x.rw === 'W', 'rw');
  need(x.approval === 'auto' || x.approval === 'team', 'approval');
  need(x.status === 'active' || x.status === 'superseded' || x.status === 'withdrawn', 'status');
  need(x.review?.verdict === 'warn' || x.review?.verdict === 'ok', 'review.verdict (reject never enters the catalog)');
  for (const k of ['task', 'stage', 'capability'] as const) {
    const vals = x.tags?.[k];
    need(Array.isArray(vals) && vals.every((v) => vocab[k].includes(v)), `tags.${k} outside vocab`);
  }
  if (x.kind === 'mcp') {
    need(x.approval === 'team', 'mcp needs team approval');
    need(SRI512.test(x.package?.integrity ?? ''), 'package.integrity');
    need(Array.isArray(x.package?.deps) && x.package.deps.every((d) => SRI512.test(d.integrity)), 'package.deps integrity');
    need(Array.isArray(x.tools) && x.tools.length > 0 && x.tools.every((t) => t.rw === 'R' || t.rw === 'W'), 'tools');
    need(x.rw === (x.tools?.some((t) => t.rw === 'W') ? 'W' : 'R'), 'mcp rw must follow its tools');
  } else if (x.kind === 'skill') {
    need(x.package === null && Array.isArray(x.tools) && x.tools.length === 0, 'skill has no package or tools');
    need(typeof x.commit === 'string' && /^[0-9a-f]{40}$/.test(x.commit), 'skill commit');
  }
  return e;
}

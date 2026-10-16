import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import type { Kind, RW, Tags, Tool, Verdict, Vocab } from './item.ts';
import { MODEL } from './limits.ts';

// Claude 한 번 부르기. 도구 없음, 구조화 출력(설계 4.3·9절). 시험에서는 가짜로 바꾼다.
export type Ask = (system: string, user: string, schema: Record<string, unknown>) => Promise<{ ok: true; json: unknown } | { ok: false; why: string }>;

export function claudeAsk(client = new Anthropic()): Ask {
  return async (system, user, schema) => {
    const r = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (r.stop_reason === 'refusal') return { ok: false, why: `refused (${r.stop_details?.category ?? 'unknown'})` };
    if (r.stop_reason === 'max_tokens') return { ok: false, why: 'output cut at max_tokens' };
    const text = r.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') return { ok: false, why: 'no text block' };
    try {
      return { ok: true, json: JSON.parse(text.text) };
    } catch {
      return { ok: false, why: 'answer was not JSON' };
    }
  };
}

const prompt = (name: string) => readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8');

export interface ReviewFile { path: string; text: string }

export function itemText(kind: Kind, files: ReviewFile[]): string {
  const body = files.map((f) => `<file path="${f.path}">\n${f.text.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')}\n</file>`);
  return `<item kind="${kind}">\n${body.join('\n')}\n</item>`;
}

const FINDING_KINDS = ['credential_read', 'exfiltration', 'shell_exec', 'obfuscation', 'install_script',
  'remote_code', 'injection', 'description_mismatch', 'file_write', 'ok_evidence'];

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'rw', 'tools', 'findings', 'summary'],
  properties: {
    verdict: { enum: ['reject', 'warn', 'ok'] },
    rw: { enum: ['R', 'W'] },
    tools: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'rw'],
      properties: { name: { type: 'string' }, rw: { enum: ['R', 'W'] } } } },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'line', 'kind', 'note'],
      properties: { file: { type: 'string' }, line: { type: 'integer' }, kind: { enum: FINDING_KINDS }, note: { type: 'string' } } } },
    summary: { type: 'string' },
  },
};

export interface Finding { file: string; line: number; kind: string; note: string }
export interface Review { verdict: Verdict; rw: RW; tools: Tool[]; findings: Finding[]; summary: string }

const isRW = (v: unknown) => v === 'R' || v === 'W';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isReview = (v: unknown): v is Review => isObj(v) && ['reject', 'warn', 'ok'].includes(v.verdict as string) && isRW(v.rw)
  && Array.isArray(v.tools) && v.tools.every((t) => isObj(t) && typeof t.name === 'string' && isRW(t.rw))
  && Array.isArray(v.findings) && v.findings.every(isObj) && typeof v.summary === 'string';

export async function reviewItem(ask: Ask, kind: Kind, files: ReviewFile[]): Promise<Review> {
  const r = await ask(prompt('reviewer'), itemText(kind, files), REVIEW_SCHEMA);
  const cannot = (why: string): Review => ({ verdict: 'warn', rw: 'W', tools: [], findings: [], summary: `검토 못 함: ${why}` });
  if (!r.ok) return cannot(r.why);
  if (!isReview(r.json)) return cannot('malformed review answer');
  const out = r.json;
  const lines = new Map(files.filter((f) => f.path !== '(binary files)').map((f) => [f.path, f.text.split('\n').length]));
  const real = (f: Finding) => f.line >= 1 && f.line <= (lines.get(f.file) ?? 0);
  const downgrade = (why: string): Review => ({ ...out, verdict: 'warn', summary: `${out.summary} (warn: ${why})` });
  if (kind === 'mcp') out.rw = out.tools.length > 0 && out.tools.every((t) => t.rw === 'R') ? 'R' : 'W';
  if (out.verdict !== 'ok') return out;
  if (!out.findings.some((f) => f.kind === 'ok_evidence' && real(f))) return downgrade('ok without evidence lines that exist');
  // 위험 발견을 적고도 ok라고 하면 판정과 근거가 어긋난다. skill이 자동 병합되지 않게 warn으로 둔다.
  if (out.findings.some((f) => f.kind !== 'ok_evidence')) return downgrade('ok with danger findings');
  if (kind === 'mcp' && out.tools.length === 0) return downgrade('no tools found');
  return out;
}

export async function tagItem(ask: Ask, vocab: Vocab, kind: Kind, files: ReviewFile[]): Promise<Tags & { new_chips: string[] }> {
  const arr = (vals: string[]) => ({ type: 'array', items: { enum: vals }, uniqueItems: true });
  const schema = {
    type: 'object', additionalProperties: false, required: ['task', 'stage', 'capability', 'needs_shell', 'windows', 'new_chips'],
    properties: {
      task: arr(vocab.task), stage: arr(vocab.stage), capability: arr(vocab.capability),
      needs_shell: { type: 'boolean' }, windows: { enum: ['yes', 'no', 'unknown'] },
      new_chips: { type: 'array', items: { type: 'string' } },
    },
  };
  const r = await ask(prompt('tagger'), itemText(kind, files), schema);
  if (!r.ok) throw new Error(`tagging failed: ${r.why}`);
  const t = r.json as Tags & { new_chips: string[] };
  const keep = (vals: string[], allowed: string[]) => vals.filter((v) => allowed.includes(v));
  return { ...t, task: keep(t.task, vocab.task), stage: keep(t.stage, vocab.stage), capability: keep(t.capability, vocab.capability) };
}

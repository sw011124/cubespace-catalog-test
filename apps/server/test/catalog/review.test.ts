import { describe, expect, it } from 'vitest';
import type { Vocab } from '../../src/catalog/item.ts';
import type Anthropic from '@anthropic-ai/sdk';
import { claudeAsk, itemText, reviewItem, tagItem, type Ask } from '../../src/catalog/review.ts';

const files = [{ path: 'dist/index.js', text: 'const fs = require("fs");\nexport const list = (d) => fs.readdirSync(d);' }];
const answer = (json: unknown): Ask => async () => ({ ok: true, json });
const ok = (extra: object = {}) => ({
  verdict: 'ok', rw: 'R', tools: [{ name: 'list_dir', rw: 'R' }],
  findings: [{ file: 'dist/index.js', line: 2, kind: 'ok_evidence', note: 'read only' }], summary: '폴더 목록을 읽는다', ...extra,
});

describe('itemText', () => {
  it('numbers every line inside file tags', () => {
    expect(itemText('mcp', files)).toBe('<item kind="mcp">\n<file path="dist/index.js">\n1: const fs = require("fs");\n2: export const list = (d) => fs.readdirSync(d);\n</file>\n</item>');
  });
});

describe('reviewItem', () => {
  it('keeps ok with real evidence and derives mcp rw from its tools', async () => {
    const r = await reviewItem(answer(ok({ rw: 'R', tools: [{ name: 'list_dir', rw: 'R' }, { name: 'rm', rw: 'W' }] })), 'mcp', files);
    expect(r.verdict).toBe('ok');
    expect(r.rw).toBe('W');
  });

  it.each([
    ['no evidence', ok({ findings: [] }), 'ok without evidence'],
    ['evidence on a line that does not exist', ok({ findings: [{ file: 'dist/index.js', line: 99, kind: 'ok_evidence', note: '' }] }), 'ok without evidence'],
    ['evidence in a file that was not sent', ok({ findings: [{ file: 'other.js', line: 1, kind: 'ok_evidence', note: '' }] }), 'ok without evidence'],
    ['mcp with no tools', ok({ tools: [] }), 'no tools found'],
    ['a danger finding next to the evidence', ok({ findings: [...ok().findings, { file: 'dist/index.js', line: 1, kind: 'shell_exec', note: '' }] }),
      'ok with danger findings'],
    ['evidence that cites the (binary files) list', ok({ findings: [{ file: '(binary files)', line: 1, kind: 'ok_evidence', note: '' }] }), 'ok without evidence'],
  ])('downgrades ok to warn: %s', async (_name, json, why) => {
    const r = await reviewItem(answer(json), 'mcp', [...files, { path: '(binary files)', text: 'logo.png' }]);
    expect(r.verdict).toBe('warn');
    expect(r.summary).toContain(why);
  });

  it('downgrades a skill too when ok comes with a danger finding', async () => {
    const json = ok({ findings: [...ok().findings, { file: 'dist/index.js', line: 1, kind: 'exfiltration', note: '' }] });
    expect((await reviewItem(answer(json), 'skill', files)).verdict).toBe('warn');
  });

  it('gives an mcp with no tools rw W, not R', async () => {
    const r = await reviewItem(answer(ok({ tools: [] })), 'mcp', files);
    expect(r).toMatchObject({ verdict: 'warn', rw: 'W' });
  });

  it.each([['null', null], ['missing fields', { verdict: 'ok' }]])('turns a malformed answer into warn and W: %s', async (_name, json) => {
    const r = await reviewItem(answer(json), 'mcp', files);
    expect(r).toMatchObject({ verdict: 'warn', rw: 'W', summary: '검토 못 함: malformed review answer' });
  });

  it('turns a refusal or failure into warn so a person looks at it', async () => {
    const r = await reviewItem(async () => ({ ok: false, why: 'refused (cyber)' }), 'mcp', files);
    expect(r).toMatchObject({ verdict: 'warn', rw: 'W', summary: '검토 못 함: refused (cyber)' });
  });

  it('passes reject through untouched', async () => {
    const r = await reviewItem(answer({ ...ok(), verdict: 'reject' }), 'skill', files);
    expect(r.verdict).toBe('reject');
  });
});

describe('claudeAsk', () => {
  const client = (content: unknown[], stop_reason = 'end_turn', stop_details: unknown = null) =>
    ({ beta: { messages: { create: async () => ({ content, stop_reason, stop_details }) } } }) as unknown as Anthropic;
  it('parses the JSON answer', async () => {
    expect(await claudeAsk(client([{ type: 'text', text: '{"a":1}' }]))('s', 'u', {})).toEqual({ ok: true, json: { a: 1 } });
  });
  it('reports refusals and non-JSON answers instead of throwing', async () => {
    expect(await claudeAsk(client([], 'refusal', { category: 'cyber' }))('s', 'u', {})).toEqual({ ok: false, why: 'refused (cyber)' });
    expect(await claudeAsk(client([{ type: 'text', text: 'Sorry,' }]))('s', 'u', {})).toEqual({ ok: false, why: 'answer was not JSON' });
  });
});

describe('tagItem', () => {
  const vocab: Vocab = { task: ['bugfix'], stack: [], capability: ['github'], stage: ['plan', 'fix'] };
  it('builds enum schemas from the vocab and drops anything outside it', async () => {
    let schema: { properties: { task: { items: { enum: string[] } } } } | undefined;
    const ask: Ask = async (_s, _u, sc) => {
      schema = sc as typeof schema;
      return { ok: true, json: { task: ['bugfix', 'teleport'], stage: ['fix'], capability: [], needs_shell: false, windows: 'unknown', new_chips: ['ci'] } };
    };
    const t = await tagItem(ask, vocab, 'skill', files);
    expect(schema?.properties.task.items.enum).toEqual(['bugfix']);
    expect(t).toMatchObject({ task: ['bugfix'], stage: ['fix'], new_chips: ['ci'] });
  });
});

// CI에서 저장소의 실제 목록 파일을 검사한다. 크롤러 PR도 이 시험을 통과해야 병합된다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkItem, loadVocab } from '../../src/catalog/item.ts';

const root = fileURLToPath(new URL('../../catalog/', import.meta.url));
const vocab = loadVocab(join(root, 'vocab.json'));
const files = (['mcp', 'skill'] as const).flatMap((kind) => {
  const dir = join(root, 'items', kind);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ kind, f, path: join(dir, f) })) : [];
});

describe('catalog data', () => {
  it('has a vocab with every chip axis', () => {
    expect(Object.keys(vocab).sort()).toEqual(['capability', 'stack', 'stage', 'task']);
  });
  it.each(files.map((x) => [`${x.kind}/${x.f}`, x] as const))('%s is a valid item in the right folder', (_n, x) => {
    const item = JSON.parse(readFileSync(x.path, 'utf8'));
    expect(checkItem(item, vocab)).toEqual([]);
    expect([item.kind, `${item.id}.json`]).toEqual([x.kind, x.f]);
  });
});

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/catalog/pkg.ts';
import { watchPages } from '../../src/catalog/watch.ts';
import { fakeHttp } from './fake.ts';

describe('watchPages', () => {
  it('reports changed pages and records new hashes only with --update', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'watch-')), 'watch.json');
    writeFileSync(file, JSON.stringify({ 'https://a/x.md': sha256('same'), 'https://b/y.md': null }));
    const { http } = fakeHttp({ 'https://a/x.md': 'same', 'https://b/y.md': 'new text' });
    expect(await watchPages(http, file, false)).toEqual(['https://b/y.md']);
    expect(JSON.parse(readFileSync(file, 'utf8'))['https://b/y.md']).toBeNull();
    await watchPages(http, file, true);
    expect(await watchPages(http, file, false)).toEqual([]);
  });
});

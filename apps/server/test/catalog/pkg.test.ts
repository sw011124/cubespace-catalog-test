import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractTarball, fetchTarball, lockDeps, reviewFiles, sri512, unsafeNames } from '../../src/catalog/pkg.ts';
import { fakeHttp } from './fake.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'pkg-test-'));

function makeTarball(): Buffer {
  const src = tmp();
  mkdirSync(join(src, 'package', 'dist'), { recursive: true });
  writeFileSync(join(src, 'package', 'package.json'), '{"name":"x"}');
  writeFileSync(join(src, 'package', 'dist', 'index.js'), 'export const a = 1;\n');
  writeFileSync(join(src, 'package', 'logo.png'), 'binary');
  writeFileSync(join(src, 'package', 'dist', 'index.d.ts'), 'export declare const a: number;');
  symlinkSync('/etc/hosts', join(src, 'package', 'dist', 'leak.js'));
  execFileSync('tar', ['-czf', join(src, 'p.tgz'), '-C', src, 'package']);
  return readFileSync(join(src, 'p.tgz'));
}

describe('fetchTarball', () => {
  it('returns the bytes when integrity matches and throws when it does not', async () => {
    const buf = new Uint8Array([1, 2, 3]);
    const { http } = fakeHttp({ 'https://r/x.tgz': buf });
    expect([...(await fetchTarball(http, 'https://r/x.tgz', sri512(buf)))]).toEqual([1, 2, 3]);
    await expect(fetchTarball(http, 'https://r/x.tgz', sri512(new Uint8Array([9])))).rejects.toThrow('integrity mismatch');
  });
});

describe('tarball safety', () => {
  it('flags absolute and parent paths', () => {
    expect(unsafeNames(['package/a.js', 'package/../../x', '/etc/passwd', 'package/..hidden'])).toEqual(['package/../../x', '/etc/passwd']);
  });

  it('extracts and hands only regular text files to the reviewer, never symlinks', () => {
    const dest = tmp();
    extractTarball(makeTarball(), dest);
    const files = reviewFiles(join(dest, 'package'));
    expect(files.map((f) => f.path)).toEqual(['dist/index.js', 'package.json']);
    expect(files[0].text).toBe('export const a = 1;\n');
  });
});

// 네트워크가 필요하다: CATALOG_NET=1 pnpm test
describe.skipIf(!process.env.CATALOG_NET)('lockDeps (network)', () => {
  it('pins every dependency with an sha512 integrity', () => {
    const deps = lockDeps('@modelcontextprotocol/server-filesystem', '1.0.0');
    expect(deps.length).toBeGreaterThan(5);
    expect(deps.every((d) => /^sha512-/.test(d.integrity) && d.version)).toBe(true);
    expect(deps.some((d) => d.name === '@modelcontextprotocol/server-filesystem')).toBe(false);
  }, 120_000);
});

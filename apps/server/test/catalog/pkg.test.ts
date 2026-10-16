import { execFileSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BadPackage, extractTarball, fetchTarball, lockDeps, reviewFiles, sri512, unsafeNames } from '../../src/catalog/pkg.ts';
import { fakeHttp } from './fake.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'pkg-test-'));

function makeTarball(): Buffer {
  const src = tmp();
  mkdirSync(join(src, 'package', 'dist'), { recursive: true });
  writeFileSync(join(src, 'package', 'package.json'), '{"name":"x"}');
  writeFileSync(join(src, 'package', 'dist', 'index.js'), 'export const a = 1;\n');
  writeFileSync(join(src, 'package', 'logo.png'), 'binary');
  writeFileSync(join(src, 'package', 'dist', 'index.d.ts'), 'export declare const a: number;');
  execFileSync('tar', ['-czf', join(src, 'p.tgz'), '-C', src, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
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
    symlinkSync('/etc/hosts', join(dest, 'package', 'dist', 'leak.js'));
    const files = reviewFiles(join(dest, 'package'));
    expect(files.map((f) => f.path)).toEqual(['dist/index.js', 'package.json']);
    expect(files[0].text).toBe('export const a = 1;\n');
  });
});

// 링크 항목(심볼릭·하드링크)은 풀기 전에 막고, 바깥에는 아무것도 쓰지 않는다.
function archiveWith(setup: (pkg: string) => void): Buffer {
  const src = tmp();
  const pkg = join(src, 'package');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'a.txt'), 'a');
  setup(pkg);
  execFileSync('tar', ['-czf', join(src, 'p.tgz'), '-C', src, 'package']);
  return readFileSync(join(src, 'p.tgz'));
}

describe('link entries', () => {
  it('refuses a symlink entry and extracts nothing', () => {
    const buf = archiveWith((pkg) => symlinkSync('/etc/hosts', join(pkg, 'link')));
    const dest = tmp();
    expect(() => extractTarball(buf, dest)).toThrow('package/link');
    expect(() => extractTarball(buf, dest)).toThrow(BadPackage);
    expect(readdirSync(dest)).toEqual([]);
  });

  it('refuses a hardlink entry and extracts nothing', () => {
    const buf = archiveWith((pkg) => linkSync(join(pkg, 'a.txt'), join(pkg, 'b.txt')));
    const dest = tmp();
    expect(() => extractTarball(buf, dest)).toThrow('unsupported tar entry');
    expect(readdirSync(dest)).toEqual([]);
  });
});

// 헤더를 직접 만든 tar: tar가 보는 크기와 이 파서가 보는 크기가 다른 경우를 재현한다(체크섬은 확인하지 않는다).
function ustar(name: string, type: string, size: number, linkname = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  h.write(type, 156, 'ascii');
  h.write(linkname, 157, 'utf8');
  return h;
}

describe('header walk', () => {
  it('never creates a symlink, even when a directory header hides one in its size', () => {
    const outside = tmp();
    const tarBuf = Buffer.concat([ustar('package/d', '5', 512), ustar('package/evil', '2', 0, outside), Buffer.alloc(1024)]);
    const dest = tmp();
    try {
      extractTarball(gzipSync(tarBuf), dest);
    } catch {
      // 던져도 된다. 검사하는 것은 링크가 생기지 않았다는 점이다.
    }
    expect(readdirSync(dest, { recursive: true, withFileTypes: true }).filter((e) => e.isSymbolicLink())).toEqual([]);
  });
});

// 가짜 npm을 PATH 앞에 두고 실패 종류별로 lockDeps가 무엇을 던지는지 본다.
describe('lockDeps failures', () => {
  const withFakeNpm = (code: string, fn: () => void) => {
    const bin = tmp();
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "npm error code ${code}" >&2\nexit 1\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    const old = process.env.PATH;
    process.env.PATH = `${bin}:${old}`;
    try { fn(); } finally { process.env.PATH = old; }
  };

  it.each(['E404', 'ETARGET', 'ERESOLVE'])('turns npm %s into a BadPackage with that code', (code) => {
    withFakeNpm(code, () => {
      expect(() => lockDeps('x', '1.0.0')).toThrow(BadPackage);
      expect(() => lockDeps('x', '1.0.0')).toThrow(`npm error code ${code}`);
    });
  });

  it('rethrows other failures (network, timeout) as they are', () => {
    withFakeNpm('ECONNRESET', () => {
      let err: unknown;
      try { lockDeps('x', '1.0.0'); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(BadPackage);
    });
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

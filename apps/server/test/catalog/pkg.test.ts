import { execFileSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_UNPACKED_BYTES } from '../../src/catalog/limits.ts';
import { BadPackage, extractTarball, fetchTarball, lockDeps, reviewFiles, sri512, unsafeNames } from '../../src/catalog/pkg.ts';
import { fakeHttp } from './fake.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'pkg-test-'));

function makeTarball(): Buffer {
  const src = tmp();
  mkdirSync(join(src, 'package', 'dist'), { recursive: true });
  writeFileSync(join(src, 'package', 'package.json'), '{"name":"x"}');
  writeFileSync(join(src, 'package', 'dist', 'index.js'), 'export const a = 1;\n');
  writeFileSync(join(src, 'package', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
  writeFileSync(join(src, 'package', 'dist', 'index.d.ts'), 'export declare const a: number;');
  writeFileSync(join(src, 'package', 'dist', 'index.js.map'), '{}');
  writeFileSync(join(src, 'package', 'dist', 'index.d.cts'), 'export declare const a: number;');
  writeFileSync(join(src, 'package', 'dist', 'index.d.mts'), 'export declare const a: number;');
  writeFileSync(join(src, 'package', 'LICENSE'), 'MIT License');
  writeFileSync(join(src, 'package', 'LICENSE.md'), 'MIT License');
  writeFileSync(join(src, 'package', 'dist', 'strings.txt'), 'require("child_process")');
  mkdirSync(join(src, 'package', 'bin'));
  writeFileSync(join(src, 'package', 'bin', 'cli'), '#!/usr/bin/env node\nrequire("../dist/strings.txt");\n');
  mkdirSync(join(src, 'package', 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(src, 'package', 'node_modules', 'dep', 'index.js'), 'module.exports = 1;');
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

  // 확장자와 상관없이 글 파일은 모두(묶인 node_modules까지) 넘긴다. 바이너리는 내용 대신 경로만 한 항목으로 넘긴다.
  it('hands every regular text file to the reviewer, lists binaries by path, never follows symlinks', () => {
    const dest = tmp();
    extractTarball(makeTarball(), dest);
    symlinkSync('/etc/hosts', join(dest, 'package', 'dist', 'leak.js'));
    const files = reviewFiles(join(dest, 'package'));
    expect(files.map((f) => f.path)).toEqual(
      ['bin/cli', 'dist/index.js', 'dist/strings.txt', 'node_modules/dep/index.js', 'package.json', '(binary files)']);
    expect(files[1].text).toBe('export const a = 1;\n');
    expect(files.at(-1)!.text).toBe('logo.png');
  });

  // 코드 파일은 NUL이 있어도 Node가 실행한다. 바이너리 목록에 숨기지 않고 NUL을 \0으로 바꿔 글로 보여 준다.
  it('shows code files with NUL bytes as text with a visible marker and lists only other NUL files as binary', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'util.js'), '/* \0 */ console.log(1);');
    writeFileSync(join(dir, 'run'), '#!/usr/bin/env node\n\0require("./util.js")');
    writeFileSync(join(dir, 'Lib.JS'), 'x\0y');
    writeFileSync(join(dir, 'data.bin'), Buffer.from([1, 0, 2]));
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0]));
    const files = reviewFiles(dir);
    expect(files.map((f) => f.path)).toEqual(['Lib.JS', 'run', 'util.js', '(binary files)']);
    expect(files[0].text).toBe('x\\0y');
    expect(files[1].text).toBe('#!/usr/bin/env node\n\\0require("./util.js")');
    expect(files[2].text).toBe('/* \\0 */ console.log(1);');
    expect(files[3].text).toBe('data.bin\nlogo.png');
  });

  it('keeps the old extension filter when a caller passes extensions', () => {
    const dest = tmp();
    extractTarball(makeTarball(), dest);
    expect(reviewFiles(join(dest, 'package'), ['.js']).map((f) => f.path)).toEqual(['dist/index.js', 'node_modules/dep/index.js']);
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
  it('refuses a gzip that unpacks past MAX_UNPACKED_BYTES', () => {
    const dest = tmp();
    expect(() => extractTarball(gzipSync(Buffer.alloc(MAX_UNPACKED_BYTES + 1)), dest)).toThrow(BadPackage);
    expect(readdirSync(dest)).toEqual([]);
  });

  it('turns a write-time failure (a file where a folder must go) into a BadPackage', () => {
    const tarBuf = Buffer.concat([ustar('package/a', '0', 0), ustar('package/a/b', '0', 0), Buffer.alloc(1024)]);
    expect(() => extractTarball(gzipSync(tarBuf), tmp())).toThrow(BadPackage);
  });

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
  const withFakeNpm = (script: string, fn: () => void) => {
    const bin = tmp();
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    const old = process.env.PATH;
    process.env.PATH = `${bin}:${old}`;
    try { fn(); } finally { process.env.PATH = old; }
  };
  const failWith = (...lines: string[]) => `printf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')} >&2\nexit 1`;
  const lockWith = (packages: object) => `echo '${JSON.stringify({ packages })}' > package-lock.json`;

  it.each(['E404', 'ETARGET', 'ERESOLVE'])('turns npm %s into a BadPackage with that code', (code) => {
    withFakeNpm(failWith(`npm error code ${code}`), () => {
      expect(() => lockDeps('x', '1.0.0')).toThrow(BadPackage);
      expect(() => lockDeps('x', '1.0.0')).toThrow(`npm error code ${code}`);
    });
  });

  it('rethrows other failures (network, timeout) as they are', () => {
    withFakeNpm(failWith('npm error code ECONNRESET'), () => {
      let err: unknown;
      try { lockDeps('x', '1.0.0'); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(BadPackage);
    });
  });

  // git 의존성 준비는 클론 안의 .npmrc로 받은 코드를 돌릴 수 있다: git 실행 파일을 막고 비밀을 넘기지 않는다.
  it('blocks the git binary and hides secrets from npm', () => {
    const out = tmp();
    const secrets = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN'];
    for (const k of secrets) process.env[k] = 'secret';
    try {
      withFakeNpm(`printf '%s\\n' "$@" > '${out}/args'\nenv > '${out}/env'\n${lockWith({
        '': {}, 'node_modules/x': { version: '1.0.0', integrity: 'sha512-x' }, 'node_modules/y': { version: '2.0.0', integrity: 'sha512-y' } })}`, () => {
        expect(lockDeps('x', '1.0.0')).toEqual([{ name: 'y', version: '2.0.0', integrity: 'sha512-y' }]);
      });
    } finally {
      for (const k of secrets) delete process.env[k];
    }
    expect(readFileSync(join(out, 'args'), 'utf8').split('\n')).toContain('--git=/usr/bin/false');
    const env = readFileSync(join(out, 'env'), 'utf8');
    for (const k of secrets) expect(env).not.toMatch(new RegExp(`^${k}=`, 'm'));
  });

  it('turns a failure in a git dependency into a BadPackage', () => {
    withFakeNpm(failWith('npm error code 1', 'npm error An unknown git error occurred',
      'npm error command /usr/bin/false --no-replace-objects ls-remote ssh://git@github.com/someone/x.git'), () => {
      expect(() => lockDeps('x', '1.0.0')).toThrow(BadPackage);
      expect(() => lockDeps('x', '1.0.0')).toThrow('git dependency');
    });
  });

  it('refuses a resolved dependency without an sha512 integrity (git, bundled, file, remote)', () => {
    withFakeNpm(lockWith({ '': {}, 'node_modules/x': { version: '1.0.0', integrity: 'sha512-x' },
      'node_modules/g': { version: '1.0.0', resolved: 'git+ssh://git@github.com/someone/g.git#0123' } }), () => {
      expect(() => lockDeps('x', '1.0.0')).toThrow(BadPackage);
      expect(() => lockDeps('x', '1.0.0')).toThrow('dependency without sha512 integrity: g');
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

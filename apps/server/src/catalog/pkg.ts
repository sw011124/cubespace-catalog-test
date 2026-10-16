// npm 패키지 파일을 받아 해시를 확인하고, 검토할 글을 꺼내고, 의존성 판을 고정한다(설계 4.2·4.6절).
// 받은 코드는 어떤 경우에도 실행하지 않는다. 그래서 npm은 --package-lock-only --ignore-scripts로만 부른다.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import type { Dep } from './item.ts';
import type { Http } from './sources.ts';

export const sri512 = (buf: Uint8Array) => 'sha512-' + createHash('sha512').update(buf).digest('base64');
export const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

export async function fetchTarball(http: Http, url: string, integrity: string): Promise<Buffer> {
  const r = await http(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (sri512(buf) !== integrity) throw new Error(`integrity mismatch for ${url}`);
  return buf;
}

export const unsafeNames = (names: string[]) => names.filter((n) => n.startsWith('/') || n.split('/').includes('..'));

// 풀기 전에 목록을 보고 바깥으로 나가는 경로를 막는다.
export function extractTarball(buf: Buffer, dest: string): void {
  const file = join(dest, '.pkg.tgz');
  writeFileSync(file, buf);
  const names = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const bad = unsafeNames(names);
  if (bad.length) throw new Error(`unsafe paths in tarball: ${bad.slice(0, 3).join(', ')}`);
  execFileSync('tar', ['-xzf', file, '-C', dest, '--no-same-owner']);
  rmSync(file);
}

const REVIEW_EXT = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json', '.md'];

// 검토자에게 넘길 글. 심볼릭 링크는 따라가지 않는다(패키지 밖 파일을 읽어 보내지 않게). 동작이 없는 .d.ts는 뺀다.
export function reviewFiles(dir: string, exts = REVIEW_EXT): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink() || name === 'node_modules') continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && exts.includes(extname(name)) && !name.endsWith('.d.ts')) out.push({ path: relative(dir, p), text: readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

// npm이 푼 의존성 전체의 판과 integrity. 패키지 자신은 뺀다.
export function lockDeps(id: string, version: string): Dep[] {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-lock-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'catalog-lock', private: true }));
    execFileSync('npm', ['install', `${id}@${version}`, '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: dir, stdio: 'pipe' });
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as
      { packages: Record<string, { version?: string; integrity?: string }> };
    return Object.entries(lock.packages)
      .filter(([k]) => k && k !== `node_modules/${id}`)
      .map(([k, v]) => ({ name: k.slice(k.lastIndexOf('node_modules/') + 'node_modules/'.length), version: v.version ?? '', integrity: v.integrity ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

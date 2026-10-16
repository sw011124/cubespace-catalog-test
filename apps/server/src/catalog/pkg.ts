// npm 패키지 파일을 받아 해시를 확인하고, 검토할 글을 꺼내고, 의존성 판을 고정한다(설계 4.2·4.6절).
// 받은 코드는 어떤 경우에도 실행하지 않는다. 그래서 npm은 --package-lock-only --ignore-scripts로만 부른다.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Dep } from './item.ts';
import type { Http } from './sources.ts';

export const sri512 = (buf: Uint8Array) => 'sha512-' + createHash('sha512').update(buf).digest('base64');
export const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

// 패키지 자체가 기준에 못 미침 — 기준 미달로 남기고 다시 보지 않는다
export class BadPackage extends Error {}

export async function fetchTarball(http: Http, url: string, integrity: string): Promise<Buffer> {
  const r = await http(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (sri512(buf) !== integrity) throw new BadPackage(`integrity mismatch for ${url}`);
  return buf;
}

export const unsafeNames = (names: string[]) => names.filter((n) => n.startsWith('/') || n.split('/').includes('..'));

// 링크 항목은 풀지 않는다. tar 종류마다 링크·크기 처리가 달라서, tar에 맡기지 않고 헤더를 직접 읽어
// 일반 파일과 폴더만 쓴다. 전부 읽어 검사한 뒤에 쓴다.
type Entry = { type: string; target: string; data: Buffer };

const str = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '');

function octalField(h: Buffer, from: number, to: number): number {
  const f = h.subarray(from, to);
  if (f[0] & 0x80) throw new BadPackage('unsupported tar size (base-256)');
  const s = f.toString('ascii').replace(/[\0 ]+$/, '');
  if (!/^[0-7]*$/.test(s)) throw new BadPackage('bad tar size field');
  return s ? parseInt(s, 8) : 0;
}

// pax 기록: "<길이> <키>=<값>\n"
function paxRecords(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (let pos = 0; pos < data.length; ) {
    const sp = data.indexOf(0x20, pos);
    const lenStr = sp < 0 ? '' : data.subarray(pos, sp).toString('ascii');
    const len = /^\d+$/.test(lenStr) ? Number(lenStr) : 0;
    if (!(len > 0) || pos + len > data.length) throw new BadPackage('bad pax record');
    const rec = data.subarray(sp + 1, pos + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq < 0) throw new BadPackage('bad pax record');
    out.set(rec.slice(0, eq), rec.slice(eq + 1));
    pos += len;
  }
  return out;
}

function readEntries(tar: Buffer, root: string): Entry[] {
  const out: Entry[] = [];
  let pax = new Map<string, string>();
  let longName: string | undefined;
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const type = String.fromCharCode(h[156] || 48);
    const own = octalField(h, 124, 136);
    const meta = type === 'x' || type === 'g' || type === 'L';
    const ps = pax.get('size');
    const size = meta || ps === undefined ? own : Number(/^\d+$/.test(ps) ? ps : NaN);
    if (!Number.isFinite(size)) throw new BadPackage('bad pax size');
    const start = off + 512;
    if (start + size > tar.length) throw new BadPackage('truncated tar entry');
    const data = tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === 'x') pax = paxRecords(data);
    else if (type === 'L') longName = str(data);
    else if (type !== 'g') {
      const prefix = str(h.subarray(345, 500));
      const base = str(h.subarray(0, 100));
      const name = pax.get('path') ?? longName ?? (prefix ? `${prefix}/${base}` : base);
      pax = new Map();
      longName = undefined;
      if (type !== '0' && type !== '7' && type !== '5') throw new BadPackage(`unsupported tar entry ${name} (type "${type}")`);
      if (unsafeNames([name]).length) throw new BadPackage(`unsafe paths in tarball: ${name}`);
      const target = resolve(root, name);
      if (!(target.startsWith(root + sep) || (type === '5' && target === root))) throw new BadPackage(`unsafe paths in tarball: ${name}`);
      out.push({ type, target, data });
    }
  }
  return out;
}

export function extractTarball(buf: Buffer, dest: string): void {
  const root = resolve(dest);
  let tar: Buffer;
  try {
    tar = gunzipSync(buf);
  } catch {
    throw new BadPackage('bad gzip data');
  }
  for (const e of readEntries(tar, root)) {
    if (e.type === '5') mkdirSync(e.target, { recursive: true });
    else {
      mkdirSync(dirname(e.target), { recursive: true });
      writeFileSync(e.target, e.data);
    }
  }
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
    try {
      execFileSync('npm', ['install', `${id}@${version}`, '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
        { cwd: dir, stdio: 'pipe' });
    } catch (e) {
      // 패키지·판이 없거나(E404, ETARGET) 의존성이 서로 맞지 않으면(ERESOLVE) 패키지 탓이다. 그 밖(네트워크·시간 초과)은 그대로 던진다.
      const err = e as Error & { stdout?: Buffer; stderr?: Buffer };
      const out = `${err.stderr ?? ''}\n${err.stdout ?? ''}\n${err.message}`;
      const m = /npm (?:error|ERR!) code (E404|ETARGET|ERESOLVE)/.exec(out);
      if (m) throw new BadPackage(`npm error code ${m[1]}`);
      throw e;
    }
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

// 프롬프트 틀의 참고 출처(설계 6절)가 바뀌었는지 본다. 바뀌면 워크플로가 "틀 재검토" 이슈를 연다.
// 기준 해시는 팀이 틀을 다시 본 뒤 `catalog watch --update`로 올린다.
import { readFileSync, writeFileSync } from 'node:fs';
import { sha256 } from './pkg.ts';
import type { Http } from './sources.ts';

export async function watchPages(http: Http, file: string, update: boolean): Promise<string[]> {
  const pages = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string | null>;
  const changed: string[] = [];
  for (const [url, old] of Object.entries(pages)) {
    const r = await http(url);
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    const h = sha256(await r.text());
    if (h === old) continue;
    changed.push(url);
    if (update) pages[url] = h;
  }
  if (update) writeFileSync(file, JSON.stringify(pages, null, 2) + '\n');
  return changed;
}

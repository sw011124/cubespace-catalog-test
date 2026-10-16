import { LICENSES, MAX_DAYS_SINCE_PUSH, MAX_DEPS, MAX_REVIEW_CHARS, MIN_STARS, SKILL_TEXT_LIMIT } from './limits.ts';

// 설계 4.2절의 코드 검사에 쓰는 사실들. 가져오기는 sources.ts·pkg.ts가 하고, 여기서는 판단만 한다.
export interface Facts {
  registryStatus: string | null; // MCP Registry status. skill은 null
  archived: boolean;
  stars: number;
  pushedAt: string; // ISO
  license: string | null; // SPDX
  vulns: string[]; // OSV id
  depCount: number;
  reviewChars: number;
  scriptFiles: string[]; // skill 폴더 안의 스크립트 파일
  skillTextBytes: number;
}

// drop = 목록에 넣지 않는다. human = 자동으로 넣지 않고 사람에게 넘긴다. pass = Claude 검토로 간다.
export type Gate = { kind: 'pass' } | { kind: 'drop' | 'human'; reasons: string[] };

const DAY_MS = 24 * 60 * 60 * 1000;

export function gate(f: Facts, now: Date): Gate {
  const drop: string[] = [];
  if (f.registryStatus === 'deleted' || f.registryStatus === 'deprecated') drop.push(`registry status ${f.registryStatus}`);
  if (f.archived) drop.push('repository archived');
  if (f.stars < MIN_STARS) drop.push(`stars ${f.stars} < ${MIN_STARS}`);
  const age = (now.getTime() - Date.parse(f.pushedAt)) / DAY_MS;
  if (!(age <= MAX_DAYS_SINCE_PUSH)) drop.push(`last push ${Math.floor(age)} days ago > ${MAX_DAYS_SINCE_PUSH}`);
  if (!f.license || !LICENSES.includes(f.license)) drop.push(`license ${f.license ?? 'none'} not allowed`);
  if (f.vulns.length) drop.push(`known vulnerabilities ${f.vulns.join(', ')}`);
  if (f.scriptFiles.length) drop.push(`skill contains scripts (U-82): ${f.scriptFiles.join(', ')}`);
  if (f.skillTextBytes > SKILL_TEXT_LIMIT) drop.push(`skill text ${f.skillTextBytes} B > ${SKILL_TEXT_LIMIT}`);
  if (drop.length) return { kind: 'drop', reasons: drop };

  const human: string[] = [];
  if (f.depCount > MAX_DEPS) human.push(`dependencies ${f.depCount} > ${MAX_DEPS}`);
  if (f.reviewChars > MAX_REVIEW_CHARS) human.push(`review text ${f.reviewChars} chars > ${MAX_REVIEW_CHARS}`);
  return human.length ? { kind: 'human', reasons: human } : { kind: 'pass' };
}

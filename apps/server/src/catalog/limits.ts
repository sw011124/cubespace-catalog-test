// 설계 14절의 [미정] 숫자. 팀이 값을 정하면 이 파일만 고친다.
export const MIN_STARS = 50;
export const MAX_DAYS_SINCE_PUSH = 365;
export const LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0', '0BSD', 'Unlicense'];
export const MAX_DEPS = 150;
export const MAX_REVIEW_CHARS = 600_000; // 약 20만 토큰. 실제 인기 MCP(context7·supabase·notion)가 20만 자를 넘었다
export const MAX_UNPACKED_BYTES = 100 * 1024 * 1024; // 설계 14절 크기 상한 [미정]: 풀었을 때 이보다 크면 gzip 폭탄으로 보고 뺀다
export const MAX_NEW_PER_RUN = { mcp: 10, skill: 30 } as const;

// 07 2절: skill은 SKILL.md + 참조 텍스트 합 64 KB, 스크립트 실행 없음(U-82).
export const SKILL_TEXT_LIMIT = 64 * 1024;
export const SKILL_TEXT_EXT = ['.md', '.txt'];

export const MODEL = 'claude-haiku-5-5'; // 사용자 결정(2026-10-17). 판정이 흔들리면 이 값만 바꾼다

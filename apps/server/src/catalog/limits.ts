// 설계 14절의 [미정] 숫자. 팀이 값을 정하면 이 파일만 고친다.
export const MIN_STARS = 50;
export const MAX_DAYS_SINCE_PUSH = 365;
export const LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0', '0BSD', 'Unlicense'];
export const MAX_DEPS = 150;
export const MAX_REVIEW_CHARS = 200_000;
export const MAX_NEW_PER_RUN = { mcp: 10, skill: 30 } as const;

// 07 2절: skill은 SKILL.md + 참조 텍스트 합 64 KB, 스크립트 실행 없음(U-82).
export const SKILL_TEXT_LIMIT = 64 * 1024;
export const SKILL_TEXT_EXT = ['.md', '.txt'];

export const MODEL = 'claude-opus-5-5';

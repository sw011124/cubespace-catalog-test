// 저장소 뿌리에서: node apps/server/src/catalog/cli.ts <명령>
// (pnpm run은 머리줄을 표준 출력에 붙여서 PR 본문이 더러워지므로 node로 바로 부른다)
//   crawl mcp|skill   목록 갱신. PR 본문(markdown)을 표준 출력으로 낸다. ANTHROPIC_API_KEY, GITHUB_TOKEN을 읽는다
//   seed mcp <Registry 이름...>  팀이 고른 첫 판 MCP만 본다(설계 4.1절). 기준 시각이 비어 있으면 지금으로 정한다
//   watch [--update]  참고 출처 페이지 변경 확인
//   eval-review       검토자 지시문을 견본으로 실제 호출해 본다(비용이 든다, CI에서 돌리지 않는다)
import Anthropic from '@anthropic-ai/sdk';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawl, summaryMarkdown } from './crawl.ts';
import { lockDeps } from './pkg.ts';
import { claudeAsk, reviewItem } from './review.ts';
import { watchPages } from './watch.ts';

const root = fileURLToPath(new URL('../../catalog/', import.meta.url));
const [cmd, arg] = process.argv.slice(2);

// 키가 없으면 항목마다 '오류'만 쌓이고 그 결과로 PR이 열린다(2026-10-17 Actions 시험). 시작할 때 실패시킨다.
if ((cmd === 'crawl' || cmd === 'seed' || cmd === 'eval-review') && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error('ANTHROPIC_API_KEY is not set (Actions: repository secret ANTHROPIC_API_KEY)');
  process.exit(2);
}

if ((cmd === 'crawl' && (arg === 'mcp' || arg === 'skill')) || (cmd === 'seed' && arg === 'mcp')) {
  const now = new Date();
  const env = { http: fetch, ask: claudeAsk(new Anthropic()), now, root, token: process.env.GITHUB_TOKEN, lock: lockDeps };
  const s = await crawl(arg, env, cmd === 'seed' ? process.argv.slice(4) : undefined);
  process.stdout.write(summaryMarkdown(s, now.toISOString().slice(0, 10)));
} else if (cmd === 'watch') {
  const changed = await watchPages(fetch, join(root, 'watch.json'), process.argv.includes('--update'));
  process.stdout.write(changed.map((u) => `- ${u}\n`).join(''));
} else if (cmd === 'eval-review') {
  const dir = fileURLToPath(new URL('../../test/catalog/fixtures/review/', import.meta.url));
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Record<string, { verdict: string; rw: string }>;
  const ask = claudeAsk(new Anthropic());
  let failed = 0;
  for (const name of readdirSync(dir).filter((f) => f in expected)) {
    const kind = name.endsWith('.md') ? 'skill' : 'mcp';
    const r = await reviewItem(ask, kind, [{ path: name, text: readFileSync(join(dir, name), 'utf8') }]);
    const exp = expected[name];
    const pass = r.verdict === exp.verdict && (exp.verdict !== 'ok' || r.rw === exp.rw);
    if (!pass) failed++;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${r.verdict}/${r.rw} (want ${exp.verdict}/${exp.rw}) ${r.summary}`);
  }
  process.exitCode = failed ? 1 : 0;
} else {
  console.error('usage: catalog crawl mcp|skill | seed mcp <name...> | watch [--update] | eval-review');
  process.exitCode = 2;
}

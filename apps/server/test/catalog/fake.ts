import type { Http } from '../../src/catalog/sources.ts';

// 녹화 응답 재생기: URL이 정확히 같은 경로를 찾고, 없으면 404를 돌려준다. 받은 요청을 calls에 남긴다.
export function fakeHttp(routes: Record<string, unknown>) {
  const calls: { url: string; body?: string }[] = [];
  const http: Http = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body as string | undefined });
    if (!(url in routes)) return new Response('not found', { status: 404 });
    const v = routes[url];
    if (v instanceof Uint8Array) return new Response(v as Uint8Array<ArrayBuffer>);
    return new Response(typeof v === 'string' ? v : JSON.stringify(v), { status: 200 });
  };
  return { http, calls };
}

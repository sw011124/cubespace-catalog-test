import { describe, expect, it } from 'vitest';
import { checkItem, idFor, type Item, type Vocab } from '../../src/catalog/item.ts';

const vocab: Vocab = { task: ['bugfix'], stack: [], capability: ['github'], stage: ['plan', 'implement'] };
const I = 'sha512-' + 'A'.repeat(86) + '==';
export const mcpItem: Item = {
  id: 'io-github-acme-gh', kind: 'mcp', name: 'io.github.acme/gh', version: '1.2.0', sha256: 'a'.repeat(64),
  source: 'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.acme%2Fgh/versions/1.2.0',
  updated_at: '2026-10-15T00:00:00Z', commit: null,
  package: { type: 'npm', id: '@acme/gh-mcp', version: '1.2.0', integrity: I, deps: [{ name: 'zod', version: '3.0.0', integrity: I }] },
  stars: 120, forks: 4, license: 'MIT', scorecard: null, verified_at: '2026-10-15T00:00:00Z',
  tags: { task: ['bugfix'], stage: ['plan', 'implement'], capability: ['github'], needs_shell: false, windows: 'unknown' },
  rw: 'W', tools: [{ name: 'get_issue', rw: 'R' }, { name: 'create_pr', rw: 'W' }],
  review: { verdict: 'ok', summary: 'reads issues, opens PRs' }, approval: 'team', status: 'active',
};

describe('idFor', () => {
  it('makes a file-safe id', () => {
    expect(idFor('io.github.Acme/GH_server')).toBe('io-github-acme-gh-server');
  });
});

describe('checkItem', () => {
  it('accepts a well-formed mcp item', () => {
    expect(checkItem(mcpItem, vocab)).toEqual([]);
  });
  it('rejects rejected verdicts, outside-vocab tags, auto-approved mcp, and rw that ignores tools', () => {
    const bad = {
      ...mcpItem, review: { verdict: 'reject', summary: '' }, approval: 'auto', rw: 'R',
      tags: { ...mcpItem.tags, capability: ['teleport'] },
    };
    expect(checkItem(bad, vocab)).toEqual(expect.arrayContaining([
      'review.verdict (reject never enters the catalog)', 'tags.capability outside vocab',
      'mcp needs team approval', 'mcp rw must follow its tools',
    ]));
  });
  it('rejects an mcp item without integrity hashes', () => {
    const bad = { ...mcpItem, package: { ...mcpItem.package!, integrity: 'md5-xx' } };
    expect(checkItem(bad, vocab)).toContain('package.integrity');
  });
  it('rejects garbage', () => {
    expect(checkItem(null, vocab).length).toBeGreaterThan(5);
  });
});

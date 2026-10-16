import { describe, expect, it } from 'vitest';
import { gate, type Facts } from '../../src/catalog/checks.ts';
import { MAX_REVIEW_CHARS } from '../../src/catalog/limits.ts';

const now = new Date('2026-10-15T00:00:00Z');
const good: Facts = {
  registryStatus: 'active', archived: false, stars: 500, pushedAt: '2026-09-01T00:00:00Z', license: 'MIT',
  vulns: [], depCount: 10, reviewChars: 5000, scriptFiles: [], skillTextBytes: 0,
};

describe('gate', () => {
  it('passes a healthy item', () => {
    expect(gate(good, now)).toEqual({ kind: 'pass' });
  });

  it.each([
    [{ registryStatus: 'deprecated' }, 'registry status deprecated'],
    [{ archived: true }, 'repository archived'],
    [{ stars: 49 }, 'stars 49 < 50'],
    [{ pushedAt: '2025-01-01T00:00:00Z' }, 'last push'],
    [{ license: null }, 'license none'],
    [{ license: 'GPL-3.0' }, 'license GPL-3.0'],
    [{ vulns: ['GHSA-xxxx'] }, 'known vulnerabilities GHSA-xxxx'],
    [{ scriptFiles: ['scripts/run.py'] }, 'skill contains scripts'],
    [{ skillTextBytes: 70_000 }, 'skill text 70000 B'],
  ] as [Partial<Facts>, string][])('drops %o', (patch, reason) => {
    const g = gate({ ...good, ...patch }, now);
    expect(g.kind).toBe('drop');
    expect(g.kind !== 'pass' && g.reasons.join(';')).toContain(reason);
  });

  it('drops when pushedAt is not a date', () => {
    expect(gate({ ...good, pushedAt: 'unknown' }, now).kind).toBe('drop');
  });

  it('hands big packages to a human instead of Claude', () => {
    expect(gate({ ...good, depCount: 151 }, now)).toEqual({ kind: 'human', reasons: ['dependencies 151 > 150'] });
    expect(gate({ ...good, reviewChars: MAX_REVIEW_CHARS + 1 }, now).kind).toBe('human');
  });

  it('drop wins over human', () => {
    expect(gate({ ...good, stars: 1, depCount: 999 }, now).kind).toBe('drop');
  });
});

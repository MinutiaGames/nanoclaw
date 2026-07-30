import { describe, expect, it } from 'bun:test';

import { buildOpenCodeConfig } from './opencode.js';

describe('buildOpenCodeConfig — permission', () => {
  it('denies webfetch and task while wildcard-allowing everything else', () => {
    const config = buildOpenCodeConfig({});
    expect(config.permission).toEqual({ '*': 'allow', webfetch: 'deny', task: 'deny' });
  });
});

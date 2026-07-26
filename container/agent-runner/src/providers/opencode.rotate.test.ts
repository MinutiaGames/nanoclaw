/**
 * Covers OpenCodeProvider.maybeRotateContinuation: a stored session is
 * provider-private to the model it was created under (OpenCode 404s if you
 * resume a session against a different model). Swapping OPENCODE_MODEL must
 * force a fresh session on next start rather than hanging on a resume that's
 * guaranteed to fail — see container/agent-runner/src/db/session-state.ts.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { initTestSessionDb } from '../db/connection.js';
import { getContinuationModel, setContinuationModel } from '../db/session-state.js';
import { OpenCodeProvider } from './opencode.js';

const ORIGINAL_MODEL = process.env.OPENCODE_MODEL;

beforeEach(() => {
  initTestSessionDb();
  delete process.env.OPENCODE_MODEL;
});

afterAll(() => {
  if (ORIGINAL_MODEL === undefined) {
    delete process.env.OPENCODE_MODEL;
  } else {
    process.env.OPENCODE_MODEL = ORIGINAL_MODEL;
  }
});

describe('OpenCodeProvider.maybeRotateContinuation', () => {
  test('no stored model (fresh/pre-fix install) — rotates', () => {
    process.env.OPENCODE_MODEL = 'lmstudio/qwen/qwen3.5-9b';
    const provider = new OpenCodeProvider();

    const reason = provider.maybeRotateContinuation!('ses_stale', '/workspace');

    expect(reason).toContain('model changed');
    expect(reason).toContain('lmstudio/qwen/qwen3.5-9b');
  });

  test('stored model matches current — does not rotate', () => {
    process.env.OPENCODE_MODEL = 'lmstudio/qwen/qwen3.5-9b';
    setContinuationModel('opencode', 'lmstudio/qwen/qwen3.5-9b');
    const provider = new OpenCodeProvider();

    expect(provider.maybeRotateContinuation!('ses_current', '/workspace')).toBeNull();
  });

  test('stored model differs from current — rotates and clears the stored marker', () => {
    setContinuationModel('opencode', 'lmstudio/google/gemma-4-e4b');
    process.env.OPENCODE_MODEL = 'lmstudio/qwen/qwen3.5-9b';
    const provider = new OpenCodeProvider();

    const reason = provider.maybeRotateContinuation!('ses_gemma_era', '/workspace');

    expect(reason).toContain('lmstudio/google/gemma-4-e4b');
    expect(reason).toContain('lmstudio/qwen/qwen3.5-9b');
    expect(getContinuationModel('opencode')).toBeUndefined();
  });

  test('model unset both times — no rotation', () => {
    const provider = new OpenCodeProvider();
    expect(provider.maybeRotateContinuation!('ses_x', '/workspace')).toBeNull();
  });
});

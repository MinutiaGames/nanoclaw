import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './connection.js';
import {
  clearContinuation,
  clearContinuationModel,
  getContinuation,
  getContinuationModel,
  migrateLegacyContinuation,
  setContinuation,
  setContinuationModel,
} from './session-state.js';

beforeEach(() => {
  initTestSessionDb();
});

function seedLegacy(value: string): void {
  getOutboundDb()
    .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('sdk_session_id', value, new Date().toISOString());
}

describe('session-state — per-provider continuations', () => {
  test('set/get round-trip, case-insensitive provider key', () => {
    setContinuation('claude', 'claude-conv-1');
    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('Claude')).toBe('claude-conv-1');
    expect(getContinuation('CLAUDE')).toBe('claude-conv-1');
  });

  test('providers are isolated — switching reads the right slot', () => {
    setContinuation('claude', 'claude-conv-1');
    setContinuation('codex', 'codex-thread-xyz');

    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('codex')).toBe('codex-thread-xyz');
  });

  test('clearContinuation only affects the specified provider', () => {
    setContinuation('claude', 'keep-me');
    setContinuation('codex', 'drop-me');

    clearContinuation('codex');

    expect(getContinuation('claude')).toBe('keep-me');
    expect(getContinuation('codex')).toBeUndefined();
  });

  test('unknown provider returns undefined', () => {
    expect(getContinuation('never-used')).toBeUndefined();
  });
});

describe('session-state — continuation model tracking', () => {
  test('set/get round-trip, isolated per provider', () => {
    setContinuationModel('opencode', 'lmstudio/qwen/qwen3.5-9b');
    setContinuationModel('claude', 'sonnet');

    expect(getContinuationModel('opencode')).toBe('lmstudio/qwen/qwen3.5-9b');
    expect(getContinuationModel('claude')).toBe('sonnet');
  });

  test('clearContinuationModel only affects the specified provider', () => {
    setContinuationModel('opencode', 'keep-me');
    setContinuationModel('claude', 'drop-me');

    clearContinuationModel('claude');

    expect(getContinuationModel('opencode')).toBe('keep-me');
    expect(getContinuationModel('claude')).toBeUndefined();
  });

  test('unset model returns undefined', () => {
    expect(getContinuationModel('opencode')).toBeUndefined();
  });

  test('does not collide with the continuation value itself', () => {
    setContinuation('opencode', 'ses_abc123');
    setContinuationModel('opencode', 'lmstudio/gemma');

    expect(getContinuation('opencode')).toBe('ses_abc123');
    expect(getContinuationModel('opencode')).toBe('lmstudio/gemma');

    clearContinuation('opencode');
    expect(getContinuation('opencode')).toBeUndefined();
    expect(getContinuationModel('opencode')).toBe('lmstudio/gemma');
  });
});

describe('session-state — legacy migration', () => {
  test('adopts legacy value into current provider when current is empty', () => {
    seedLegacy('old-session-id');

    const adopted = migrateLegacyContinuation('claude');

    expect(adopted).toBe('old-session-id');
    expect(getContinuation('claude')).toBe('old-session-id');
  });

  test('always deletes legacy row regardless of migration outcome', () => {
    seedLegacy('old-session-id');
    setContinuation('claude', 'existing');

    migrateLegacyContinuation('claude');

    // After migration the legacy key must be gone, whether or not it was adopted.
    // A subsequent migration for a different provider must not see it.
    const resultAfterSecondCall = migrateLegacyContinuation('codex');
    expect(resultAfterSecondCall).toBeUndefined();
  });

  test('prefers existing current-provider slot over legacy', () => {
    seedLegacy('legacy-value');
    setContinuation('claude', 'claude-value');

    const result = migrateLegacyContinuation('claude');

    expect(result).toBe('claude-value');
    expect(getContinuation('claude')).toBe('claude-value');
  });

  test('no legacy row — returns current provider value (possibly undefined)', () => {
    expect(migrateLegacyContinuation('claude')).toBeUndefined();

    setContinuation('codex', 'codex-value');
    expect(migrateLegacyContinuation('codex')).toBe('codex-value');
  });

  test('migration is idempotent on a second call (legacy already gone)', () => {
    seedLegacy('once');

    const first = migrateLegacyContinuation('claude');
    expect(first).toBe('once');

    const second = migrateLegacyContinuation('claude');
    expect(second).toBe('once');
  });
});

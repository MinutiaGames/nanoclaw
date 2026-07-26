import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import Database from 'better-sqlite3';

/**
 * Smoke tests for scripts/trajectory.ts against a minimal seeded
 * OpenCode-shaped database (session/message/part tables, generic
 * {data: JSON} rows — matches the real schema, not a mock).
 */

const SCRIPT = path.resolve(__dirname, 'trajectory.ts');

function seedDb(dbPath: string, sessionId: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)').run(sessionId, 1000, 2000);

  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
    'msg-user-1',
    sessionId,
    1000,
    1000,
    JSON.stringify({ role: 'user', time: { created: 1000 } }),
  );
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(
    'part-user-1',
    'msg-user-1',
    sessionId,
    1000,
    1000,
    JSON.stringify({ type: 'text', text: 'Find 5 CPAs near Austin, TX' }),
  );

  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
    'msg-asst-1',
    sessionId,
    1500,
    1500,
    JSON.stringify({
      role: 'assistant',
      modelID: 'qwen/qwen3.5-9b',
      providerID: 'lmstudio',
      tokens: { total: 100, input: 80, output: 15, reasoning: 5 },
      cost: 0,
      time: { created: 1500, completed: 4500 },
      finish: 'stop',
    }),
  );
  const parts: Array<[string, Record<string, unknown>]> = [
    ['part-1', { type: 'step-start' }],
    ['part-2', { type: 'reasoning', text: 'I should search the RPO directory first.' }],
    [
      'part-3',
      {
        type: 'tool',
        tool: 'web_search',
        state: { status: 'completed', input: { query: 'CPA Austin TX' }, output: '1. Jane Doe CPA\n   https://example.com' },
      },
    ],
    ['part-4', { type: 'text', text: 'Here are 5 CPAs near Austin, TX: ...' }],
    ['part-5', { type: 'step-finish', reason: 'stop', tokens: { input: 80, output: 15, reasoning: 5 }, cost: 0 }],
  ];
  for (const [id, data] of parts) {
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      'msg-asst-1',
      sessionId,
      1500,
      1500,
      JSON.stringify(data),
    );
  }
  db.close();
}

describe('scripts/trajectory.ts', () => {
  let tempDir: string;
  let sessionDir: string;
  const sessionId = 'ses_test123';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trajectory-test-'));
    sessionDir = path.join(tempDir, 'sess-fake');
    const dbDir = path.join(sessionDir, 'opencode-xdg', 'opencode');
    fs.mkdirSync(dbDir, { recursive: true });
    seedDb(path.join(dbDir, 'opencode.db'), sessionId);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(extraArgs: string[] = []): { stdout: string; stderr: string; status: number } {
    const r = spawnSync('pnpm', ['exec', 'tsx', SCRIPT, sessionDir, ...extraArgs], {
      encoding: 'utf-8',
      cwd: path.resolve(__dirname, '..'),
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
  }

  it('dumps reasoning, tool calls, and text in order', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Find 5 CPAs near Austin, TX');
    expect(r.stdout).toContain('[reasoning] I should search the RPO directory first.');
    expect(r.stdout).toContain('[tool] web_search status=completed');
    expect(r.stdout).toContain('input:  {"query":"CPA Austin TX"}');
    expect(r.stdout).toContain('Here are 5 CPAs near Austin, TX');

    const reasoningIdx = r.stdout.indexOf('[reasoning]');
    const toolIdx = r.stdout.indexOf('[tool]');
    const textIdx = r.stdout.indexOf('Here are 5 CPAs');
    expect(reasoningIdx).toBeLessThan(toolIdx);
    expect(toolIdx).toBeLessThan(textIdx);
  });

  it('reports token totals and duration', () => {
    const r = run();
    expect(r.stdout).toContain('took 3.0s');
    expect(r.stdout).toContain('message total: 100 tokens');
  });

  it('auto-resolves the most recently updated session without --session', () => {
    const r = run();
    expect(r.stdout).toContain(`Session ${sessionId}`);
  });

  it('--session filters to a specific (even nonexistent) session cleanly', () => {
    const r = run(['--session', 'ses_does_not_exist']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('0/0 message(s)');
  });

  it('--limit caps how many trailing messages are shown', () => {
    const r = run(['--limit', '1']);
    expect(r.stdout).toContain('1/2 message(s)');
    expect(r.stdout).not.toContain('Find 5 CPAs near Austin, TX');
  });

  it('exits with a clear error when the db is missing', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trajectory-empty-'));
    const r = spawnSync('pnpm', ['exec', 'tsx', SCRIPT, emptyDir], {
      encoding: 'utf-8',
      cwd: path.resolve(__dirname, '..'),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('No OpenCode database found');
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('exits 2 with usage when no session dir is given', () => {
    const r = spawnSync('pnpm', ['exec', 'tsx', SCRIPT], {
      encoding: 'utf-8',
      cwd: path.resolve(__dirname, '..'),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Usage/);
  });
});

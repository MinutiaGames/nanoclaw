/**
 * scripts/trajectory.ts — dump a session's full OpenCode trajectory:
 * reasoning, tool calls, text output, step boundaries, and per-step
 * token/cost/timing — in readable form.
 *
 * OpenCode persists this in its own SQLite store (message/part tables,
 * generic {data: JSON} rows) independent of what NanoClaw's poll-loop
 * surfaces back to the chat channel — the final chat reply only ever
 * shows the last text part, so this is the way to see everything the
 * model actually did to get there (see container/agent-runner/src/
 * providers/opencode.ts, where only `type === 'text'` parts make it into
 * the delivered result).
 *
 * Usage:
 *   pnpm exec tsx scripts/trajectory.ts <nanoclaw-session-dir> [--session <opencode-session-id>] [--limit N]
 *
 * <nanoclaw-session-dir> is a data/v2-sessions/<agent-group>/<session>/
 * directory (must contain opencode-xdg/opencode/opencode.db). Without
 * --session, dumps the most recently updated OpenCode session found
 * there. --limit caps how many messages back to show (default: all).
 */
import path from 'path';

import Database from 'better-sqlite3';

interface MessageRow {
  id: string;
  data: string;
}
interface PartRow {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
}

function usageAndExit(): never {
  console.error(
    'Usage: pnpm exec tsx scripts/trajectory.ts <nanoclaw-session-dir> [--session <opencode-session-id>] [--limit N]',
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const sessionDirArg = args.find((a) => !a.startsWith('--'));
if (!sessionDirArg) usageAndExit();

function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const explicitSessionId = flagValue('--session');
const limit = Number(flagValue('--limit') ?? '0') || undefined;

const dbPath = path.join(sessionDirArg, 'opencode-xdg', 'opencode', 'opencode.db');
let db: Database.Database;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch {
  console.error(`No OpenCode database found at ${dbPath}`);
  console.error('(pass a data/v2-sessions/<agent-group>/<session>/ directory)');
  process.exit(1);
}

function resolveSessionId(): string {
  if (explicitSessionId) return explicitSessionId;
  const row = db
    .prepare('SELECT id FROM session ORDER BY time_updated DESC LIMIT 1')
    .get() as { id: string } | undefined;
  if (!row) {
    console.error('No OpenCode sessions found in this database.');
    process.exit(1);
  }
  return row.id;
}

const sessionId = resolveSessionId();

const messages = db
  .prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC')
  .all(sessionId) as MessageRow[];

const limited = limit ? messages.slice(-limit) : messages;

function fmtTime(ms: number | undefined): string {
  if (!ms) return '?';
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

function fmtDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

console.log(`\n=== Session ${sessionId} — ${limited.length}/${messages.length} message(s) ===\n`);

for (const msgRow of limited) {
  const msg = JSON.parse(msgRow.data) as {
    role: string;
    modelID?: string;
    providerID?: string;
    tokens?: { total: number; input: number; output: number; reasoning: number; cache?: { read: number; write: number } };
    cost?: number;
    time?: { created?: number; completed?: number };
    finish?: string;
  };

  const header =
    msg.role === 'user'
      ? `--- USER (${fmtTime(msg.time?.created)}) ---`
      : `--- ASSISTANT [${msg.providerID}/${msg.modelID}] (${fmtTime(msg.time?.created)}${
          msg.time?.completed ? `, took ${fmtDurationMs(msg.time.completed - (msg.time.created ?? 0))}` : ''
        }) ---`;
  console.log(header);

  const parts = db
    .prepare('SELECT id, message_id, time_created, data FROM part WHERE message_id = ? ORDER BY time_created ASC')
    .all(msgRow.id) as PartRow[];

  for (const partRow of parts) {
    const part = JSON.parse(partRow.data) as Record<string, unknown>;
    switch (part.type) {
      case 'text':
        console.log(`  [text] ${String(part.text ?? '').trim()}`);
        break;
      case 'reasoning':
        console.log(`  [reasoning] ${String(part.text ?? '').trim()}`);
        break;
      case 'step-start':
        console.log('  [step-start]');
        break;
      case 'step-finish': {
        const t = part.tokens as Record<string, unknown> | undefined;
        console.log(
          `  [step-finish] reason=${part.reason} tokens(in/out/reasoning)=${t?.input}/${t?.output}/${t?.reasoning} cost=${part.cost}`,
        );
        break;
      }
      case 'tool': {
        // Best-effort — no live example observed yet in this install, so
        // this stays generic. Report the raw shape too so nothing's hidden.
        const state = part.state as Record<string, unknown> | undefined;
        console.log(`  [tool] ${part.tool ?? '?'} status=${state?.status ?? '?'}`);
        if (state?.input) console.log(`         input:  ${JSON.stringify(state.input)}`);
        if (state?.output) console.log(`         output: ${JSON.stringify(state.output).slice(0, 500)}`);
        break;
      }
      default:
        console.log(`  [${part.type}] ${JSON.stringify(part).slice(0, 300)}`);
    }
  }

  if (msg.tokens) {
    console.log(
      `  (message total: ${msg.tokens.total} tokens — ${msg.tokens.input} in / ${msg.tokens.output} out / ${msg.tokens.reasoning} reasoning, cost=${msg.cost ?? 0})`,
    );
  }
  console.log('');
}

db.close();

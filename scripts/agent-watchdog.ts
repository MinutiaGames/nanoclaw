/**
 * scripts/agent-watchdog.ts — catch a stuck-in-a-loop agent and stop it
 * before it burns more time/tokens, rather than discovering it later by
 * noticing CPU/GPU has been idle-but-the-container-never-finished.
 *
 * Built after watching this happen twice in the same afternoon in
 * different shapes: gemma-4-e4b called `skill(name="agent-browser")`
 * 24 times in a row without ever executing the plan it kept re-describing,
 * and qwen3-8b called `web_fetch` on the identical URL 5 times in a row
 * with near-identical reasoning each time. Neither was "stuck" in the
 * sense the idle-timeout fix in opencode.ts already covers (that's for a
 * turn genuinely blocked with no events arriving at all) — both were
 * actively generating and getting real tool results back, just choosing
 * to repeat the same action instead of making progress.
 *
 * Two detectors, two confidence levels:
 *
 * - Exact-match (HIGH confidence, auto-kills by default): N consecutive
 *   tool calls with identical tool name AND identical arguments. Always a
 *   real loop — no legitimate reason to call the same tool with the same
 *   arguments repeatedly.
 * - Same-tool streak (LOWER confidence, warns only by default): N
 *   consecutive calls to the same tool with *varying* arguments. Added
 *   after watching nemotron-3-nano-4b call `send_message` 8 times in a row
 *   with different text each time — narrating "Opening page.", "Filling
 *   ZIP.", "Clicking search." etc. as if those actions were happening,
 *   without ever calling `bash` to actually run them. Exact-match
 *   detection completely misses this shape (the arguments differ every
 *   time), but it's exactly the kind of "generating steps instead of
 *   taking them" pattern worth catching. Warn-only by default because
 *   legitimately calling the same tool many times with different
 *   arguments (e.g. several different web_search queries in a row) is
 *   normal, healthy behavior, not a loop — pass --kill-on-soft-loop to
 *   auto-stop on this signal too once you trust it for your use case.
 *
 * On trigger: print what's looping, and — unless --dry-run — stop the
 * container so it's not left running indefinitely.
 *
 * Usage:
 *   pnpm exec tsx scripts/agent-watchdog.ts <nanoclaw-session-dir> \
 *     [--session <opencode-session-id>] [--threshold N] [--soft-threshold N] \
 *     [--poll-ms N] [--dry-run] [--kill-on-soft-loop] [--container <name>]
 */
import { execSync } from 'child_process';
import path from 'path';

import Database from 'better-sqlite3';

export interface ToolCallRecord {
  tool: string;
  inputJson: string;
}

export interface RepeatDetection {
  tool: string;
  inputJson: string;
  count: number;
}

/**
 * Returns non-null once the most recent `threshold` tool calls are all
 * identical (same tool + same arguments), with `count` extended back as
 * far as the identical streak actually runs (not capped at threshold).
 */
export function detectRepeatedToolCall(history: ToolCallRecord[], threshold: number): RepeatDetection | null {
  if (threshold < 2 || history.length < threshold) return null;
  const tail = history.slice(-threshold);
  const target = tail[0];
  const allSame = tail.every((r) => r.tool === target.tool && r.inputJson === target.inputJson);
  if (!allSame) return null;

  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.tool === target.tool && h.inputJson === target.inputJson) count++;
    else break;
  }
  return { tool: target.tool, inputJson: target.inputJson, count };
}

export interface SameToolStreakDetection {
  tool: string;
  count: number;
}

/**
 * Returns non-null once the most recent `threshold` tool calls are all the
 * same tool (arguments may differ), with `count` extended back as far as
 * that streak actually runs. Deliberately does NOT fire on a streak that
 * detectRepeatedToolCall would already catch more precisely — callers
 * should check exact-match first and only fall back to this.
 */
export function detectSameToolStreak(history: ToolCallRecord[], threshold: number): SameToolStreakDetection | null {
  if (threshold < 2 || history.length < threshold) return null;
  const tail = history.slice(-threshold);
  const tool = tail[0].tool;
  const allSameTool = tail.every((r) => r.tool === tool);
  if (!allSameTool) return null;

  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].tool === tool) count++;
    else break;
  }
  return { tool, count };
}

function usageAndExit(): never {
  console.error(
    'Usage: pnpm exec tsx scripts/agent-watchdog.ts <nanoclaw-session-dir> ' +
      '[--session <opencode-session-id>] [--threshold N] [--soft-threshold N] [--poll-ms N] ' +
      '[--dry-run] [--kill-on-soft-loop] [--container <name>]',
  );
  process.exit(2);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

interface ToolPart {
  type: string;
  tool?: string;
  state?: { input?: unknown };
}

function loadToolCallHistory(db: Database.Database, sessionId: string): ToolCallRecord[] {
  const rows = db
    .prepare('SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC')
    .all(sessionId) as { data: string }[];
  const history: ToolCallRecord[] = [];
  for (const row of rows) {
    let part: ToolPart;
    try {
      part = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (part.type === 'tool' && part.tool) {
      history.push({ tool: part.tool, inputJson: JSON.stringify(part.state?.input ?? null) });
    }
  }
  return history;
}

function findNewestContainer(): string | null {
  try {
    const out = execSync("docker ps --format '{{.Names}}\\t{{.CreatedAt}}' | grep nanoclaw-v2- | sort -k2 -r | head -1", {
      encoding: 'utf-8',
      shell: '/bin/bash',
    }).trim();
    return out ? out.split('\t')[0] : null;
  } catch {
    return null;
  }
}

function stopContainer(name: string): void {
  execSync(`docker stop ${JSON.stringify(name)}`, { stdio: 'inherit' });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sessionDirArg = args.find((a) => !a.startsWith('--'));
  if (!sessionDirArg) usageAndExit();

  const explicitSessionId = flagValue(args, '--session');
  const threshold = Number(flagValue(args, '--threshold') ?? '3');
  const softThreshold = Number(flagValue(args, '--soft-threshold') ?? '6');
  const pollMs = Number(flagValue(args, '--poll-ms') ?? '5000');
  const dryRun = args.includes('--dry-run');
  const killOnSoftLoop = args.includes('--kill-on-soft-loop');
  const containerOverride = flagValue(args, '--container');

  const dbPath = path.join(sessionDirArg, 'opencode-xdg', 'opencode', 'opencode.db');

  console.log(
    `Watching ${dbPath} (threshold=${threshold}, soft-threshold=${softThreshold}, poll=${pollMs}ms, ` +
      `dry-run=${dryRun}, kill-on-soft-loop=${killOnSoftLoop})`,
  );

  // Wait for the db to exist — a fresh container may not have created it yet.
  let db: Database.Database | undefined;
  for (let i = 0; i < 30 && !db; i++) {
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!db) {
    console.error(`No OpenCode database appeared at ${dbPath} after 60s — nothing to watch.`);
    process.exit(1);
  }

  function resolveSessionId(): string | null {
    if (explicitSessionId) return explicitSessionId;
    const row = db!.prepare('SELECT id FROM session ORDER BY time_updated DESC LIMIT 1').get() as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  }

  function stopAndExit(reason: string): void {
    if (dryRun) {
      console.log('  (--dry-run: not stopping the container)');
      return;
    }
    const container = containerOverride ?? findNewestContainer();
    if (container) {
      console.log(`  Stopping container ${container} (${reason})...`);
      stopContainer(container);
      console.log('  Stopped. Exiting.');
    } else {
      console.log('  No running nanoclaw-v2-* container found to stop.');
    }
    process.exit(0);
  }

  let lastHardCount = 0;
  let lastSoftCount = 0;
  for (;;) {
    const sessionId = resolveSessionId();
    if (sessionId) {
      const history = loadToolCallHistory(db, sessionId);

      const hard = detectRepeatedToolCall(history, threshold);
      if (hard && hard.count > lastHardCount) {
        lastHardCount = hard.count;
        console.log(
          `\n[WATCHDOG] Repeated tool call detected: "${hard.tool}" called ${hard.count}x in a row with identical arguments:`,
        );
        console.log(`  ${hard.inputJson}`);
        stopAndExit('identical tool call repeated');
      } else if (!hard) {
        // Only check the lower-confidence signal when the high-confidence
        // one hasn't already fired — an exact-match streak trivially also
        // looks like a same-tool streak, and would otherwise double-report.
        const soft = detectSameToolStreak(history, softThreshold);
        if (soft && soft.count > lastSoftCount) {
          lastSoftCount = soft.count;
          console.log(
            `\n[WATCHDOG] Possible soft loop: "${soft.tool}" called ${soft.count}x in a row (arguments varied — ` +
              `lower confidence than an exact repeat, could be narrating steps without executing them; see nemotron-3-nano-4b in project memory).`,
          );
          if (killOnSoftLoop) {
            stopAndExit('same-tool streak, --kill-on-soft-loop set');
          } else {
            console.log('  (warn-only — pass --kill-on-soft-loop to auto-stop on this signal)');
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// Only auto-run when executed directly (`tsx scripts/agent-watchdog.ts ...`),
// not when imported for its exported pure functions (see agent-watchdog.test.ts) —
// otherwise importing this module would kick off the infinite poll loop.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

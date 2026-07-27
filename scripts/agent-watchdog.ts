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

export interface EscalatingRetryDetection {
  tool: string;
  count: number;
}

// Minimum shared prefix length before two tool-call inputs count as
// "substantially overlapping" — well above what a short, generic argument
// (e.g. {"query":"CPA"}) could coincidentally share, but well under a real
// task description (typically 100+ chars), so a genuine same-base-task-
// being-extended pattern still triggers reliably.
const MIN_OVERLAP_CHARS = 40;

// Common-PREFIX overlap, not substring containment: these are JSON-
// stringified tool inputs (e.g. `{"task":"...base..."}`), and the real
// pattern this detects is text getting APPENDED before the JSON closes —
// which breaks a naive "is the whole shorter string contained in the
// longer one" check, since the shorter string's own trailing `"}` never
// reappears mid-string once more text follows it. A shared prefix directly
// matches the observed shape (same opening text, extended at the end) and
// doesn't care about matching endings.
function overlapsSubstantially(a: string, b: string): boolean {
  if (a === b) return true;
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i++;
  return i >= MIN_OVERLAP_CHARS;
}

/**
 * Returns non-null once the most recent `threshold` calls are all the same
 * tool AND every call after the first shares a long common prefix with the
 * first call in that window — i.e. the same underlying request is being
 * repeatedly reformulated/extended rather than genuinely different narrow
 * requests. This is what neither detectRepeatedToolCall nor
 * detectSameToolStreak reliably catches: arguments differ every call (so
 * exact-match won't fire), and it looks like healthy varied tool use on the
 * surface (so same-tool-streak alone isn't specific enough) — but the
 * growing, overlapping argument text reveals it's the same stuck task being
 * incrementally patched, not real progress.
 *
 * Seen for real 2026-07-27: delegate_web_research called 4x for what was
 * meant to be one research task — a sanctioned identical retry, then two
 * more calls each built on the prior text, the last one injecting the
 * model's own guessed city into the query after the first attempts failed
 * (see nanoclaw-lead-gen-roadmap memory). No repeated tool call and no
 * flat "same tool streak" alone would have made that stand out; the
 * escalating shared text does.
 *
 * Deliberately simple shared-prefix matching, not fuzzy/semantic similarity
 * — this codebase has no NLP dependencies, and the real case above was a
 * literal shared-prefix-and-extend pattern. A paraphrased (not literally
 * overlapping) reformulation would not be caught by this — same
 * lower-confidence, warn-by-default spirit as detectSameToolStreak.
 */
export function detectEscalatingRetry(history: ToolCallRecord[], threshold: number): EscalatingRetryDetection | null {
  if (threshold < 2 || history.length < threshold) return null;
  const tail = history.slice(-threshold);
  const tool = tail[0].tool;
  if (!tail.every((r) => r.tool === tool)) return null;

  const anchor = tail[0].inputJson;
  const allOverlap = tail.slice(1).every((r) => overlapsSubstantially(r.inputJson, anchor));
  if (!allOverlap) return null;

  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.tool !== tool) break;
    if (h.inputJson !== anchor && !overlapsSubstantially(h.inputJson, anchor)) break;
    count++;
  }
  return { tool, count };
}

function usageAndExit(): never {
  console.error(
    'Usage: pnpm exec tsx scripts/agent-watchdog.ts <nanoclaw-session-dir> ' +
      '[--session <opencode-session-id>] [--threshold N] [--escalating-threshold N] [--soft-threshold N] ' +
      '[--poll-ms N] [--dry-run] [--kill-on-escalating-retry] [--kill-on-soft-loop] [--container <name>] ' +
      '[--exit-on-kill]',
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
  const escalatingThreshold = Number(flagValue(args, '--escalating-threshold') ?? '3');
  const softThreshold = Number(flagValue(args, '--soft-threshold') ?? '6');
  const pollMs = Number(flagValue(args, '--poll-ms') ?? '5000');
  const dryRun = args.includes('--dry-run');
  const killOnEscalatingRetry = args.includes('--kill-on-escalating-retry');
  const killOnSoftLoop = args.includes('--kill-on-soft-loop');
  const containerOverride = flagValue(args, '--container');
  const exitOnKill = args.includes('--exit-on-kill');

  const dbPath = path.join(sessionDirArg, 'opencode-xdg', 'opencode', 'opencode.db');

  console.log(
    `Watching ${dbPath} (threshold=${threshold}, escalating-threshold=${escalatingThreshold}, ` +
      `soft-threshold=${softThreshold}, poll=${pollMs}ms, dry-run=${dryRun}, ` +
      `kill-on-escalating-retry=${killOnEscalatingRetry}, kill-on-soft-loop=${killOnSoftLoop}, exit-on-kill=${exitOnKill})`,
  );
  console.log(
    '  Runs continuously across model swaps / session wipes — reopens the database whenever it ' +
      'disappears and reappears, and keeps watching after stopping a looping container.',
  );

  // db is intentionally re-openable across the whole process lifetime: a full
  // session wipe (rm -rf opencode-xdg, per the model-swap gotcha) deletes this
  // file out from under an open handle, and a fresh container recreates it a
  // moment later. Holding one static handle for the process lifetime — the
  // original design — meant every wipe required a manual watchdog restart.
  let db: Database.Database | undefined;
  let lastMissingWarnAt = 0;

  function closeDb(): void {
    if (db) {
      try {
        db.close();
      } catch {
        /* already unusable — nothing to clean up */
      }
      db = undefined;
    }
  }

  function ensureDb(): boolean {
    if (db) return true;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      console.log(`  (re)connected to ${dbPath}`);
      return true;
    } catch {
      // Expected between a session wipe and the next container creating a
      // fresh db — throttle the log instead of spamming once per poll tick.
      const now = Date.now();
      if (now - lastMissingWarnAt > 30_000) {
        console.log(`  Waiting for ${dbPath} to appear...`);
        lastMissingWarnAt = now;
      }
      return false;
    }
  }

  function resolveSessionId(): string | null {
    if (explicitSessionId) return explicitSessionId;
    const row = db!.prepare('SELECT id FROM session ORDER BY time_updated DESC LIMIT 1').get() as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  }

  /** Stop the looping container. Returns false (caller should exit) only when --exit-on-kill is set. */
  function stopAndContinue(reason: string): boolean {
    if (dryRun) {
      console.log('  (--dry-run: not stopping the container)');
      return true;
    }
    const container = containerOverride ?? findNewestContainer();
    if (container) {
      console.log(`  Stopping container ${container} (${reason})...`);
      stopContainer(container);
      console.log(exitOnKill ? '  Stopped. Exiting.' : '  Stopped. Still watching for the next run.');
    } else {
      console.log('  No running nanoclaw-v2-* container found to stop.');
    }
    return !exitOnKill;
  }

  let currentSessionId: string | null = null;
  let lastHardCount = 0;
  let lastEscalatingCount = 0;
  let lastSoftCount = 0;
  for (;;) {
    if (ensureDb()) {
      try {
        const sessionId = resolveSessionId();
        if (sessionId) {
          if (sessionId !== currentSessionId) {
            if (currentSessionId !== null) console.log(`  New session detected (${sessionId}) — resetting watchdog state.`);
            currentSessionId = sessionId;
            lastHardCount = 0;
            lastEscalatingCount = 0;
            lastSoftCount = 0;
          }

          const history = loadToolCallHistory(db!, sessionId);

          const hard = detectRepeatedToolCall(history, threshold);
          if (hard && hard.count > lastHardCount) {
            lastHardCount = hard.count;
            console.log(
              `\n[WATCHDOG] Repeated tool call detected: "${hard.tool}" called ${hard.count}x in a row with identical arguments:`,
            );
            console.log(`  ${hard.inputJson}`);
            if (!stopAndContinue('identical tool call repeated')) process.exit(0);
          } else if (!hard) {
            // Escalating-retry is more specific than the plain same-tool
            // streak below (it also requires the arguments to textually
            // build on each other, not just share a tool name), so check it
            // first — a real escalating-retry run would otherwise also
            // trigger the soft streak and get the less informative message.
            const escalating = detectEscalatingRetry(history, escalatingThreshold);
            if (escalating && escalating.count > lastEscalatingCount) {
              lastEscalatingCount = escalating.count;
              console.log(
                `\n[WATCHDOG] Possible escalating retry: "${escalating.tool}" called ${escalating.count}x in a row ` +
                  `with each call's input textually building on an earlier one — looks like the same stuck task ` +
                  `being repeatedly reformulated/extended rather than real progress (see the Davenport/Marion ` +
                  `delegate_web_research case in project memory).`,
              );
              if (killOnEscalatingRetry) {
                if (!stopAndContinue('escalating retry, --kill-on-escalating-retry set')) process.exit(0);
              } else {
                console.log('  (warn-only — pass --kill-on-escalating-retry to auto-stop on this signal)');
              }
            } else if (!escalating) {
              // Only check the lowest-confidence signal when neither
              // higher-confidence one has already fired.
              const soft = detectSameToolStreak(history, softThreshold);
              if (soft && soft.count > lastSoftCount) {
                lastSoftCount = soft.count;
                console.log(
                  `\n[WATCHDOG] Possible soft loop: "${soft.tool}" called ${soft.count}x in a row (arguments varied — ` +
                    `lower confidence than an exact repeat, could be narrating steps without executing them; see nemotron-3-nano-4b in project memory).`,
                );
                if (killOnSoftLoop) {
                  if (!stopAndContinue('same-tool streak, --kill-on-soft-loop set')) process.exit(0);
                } else {
                  console.log('  (warn-only — pass --kill-on-soft-loop to auto-stop on this signal)');
                }
              }
            }
          }
        }
      } catch (err) {
        // Most likely the underlying file vanished mid-query (a session wipe
        // racing this poll tick) — drop the handle and let the next tick's
        // ensureDb() reconnect once the fresh file exists.
        console.log(`  Lost database connection (${err instanceof Error ? err.message : String(err)}) — will retry.`);
        closeDb();
        currentSessionId = null;
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

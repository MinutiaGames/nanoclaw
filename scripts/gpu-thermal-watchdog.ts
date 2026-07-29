/**
 * scripts/gpu-thermal-watchdog.ts — stop an unattended CRM enrichment batch
 * if the GPU's hot spot temperature stays pinned at/above a threshold,
 * rather than trusting the card's own thermal throttling to be enough
 * during long unattended runs.
 *
 * Reads HWiNFO's CSV sensor log (Windows-side, reachable from WSL2 at its
 * /mnt/c/... path) — HWiNFO has no free network/WMI API, but its continuous
 * CSV logging feature works fine for this: polling a file's contents on an
 * interval doesn't depend on inotify propagating across the DrvFs boundary
 * the way file-watching does (see the LM Studio dev-server gotcha this
 * session — that was about hot-reload, not plain reads).
 *
 * On trigger: stops the running ping-test container (best-effort — the
 * container is only the HTTP client; LM Studio on the Windows side is the
 * actual GPU consumer, so this can ask it to stop by dropping the
 * connection, not force it) and, if given the batch script's PID, kills
 * that process group so the batch doesn't just move on to the next run.
 *
 * Deliberately one-shot: on trigger it stops everything and exits. It does
 * not wait for the GPU to cool down and resume automatically — that's a
 * planned follow-up, not built yet.
 *
 * Usage:
 *   pnpm exec tsx scripts/gpu-thermal-watchdog.ts \
 *     [--log <path>] [--column <substring>] [--threshold <celsius>] \
 *     [--sustained-secs <N>] [--poll-ms <N>] [--kill-pid <PID>] [--dry-run]
 */
import { execSync } from 'child_process';
import { readFileSync, statSync } from 'fs';

export interface CsvReading {
  value: number;
  dateTime: string;
}

/** Splits one CSV line on commas, stripping surrounding double quotes from each field. */
export function splitCsvLine(line: string): string[] {
  return line.split(',').map((f) => f.trim().replace(/^"|"$/g, ''));
}

/**
 * Parses a HWiNFO CSV log and returns the latest row's value for the
 * column whose header includes `columnSubstring` (case-insensitive) —
 * matched by substring rather than an exact header string since the
 * degree-sign suffix ("[°C]") depends on getting the file's byte encoding
 * exactly right, which this deliberately doesn't need to do to find the
 * column (HWiNFO's CSV export is Latin-1, not UTF-8 — confirmed live).
 */
export function parseLatestReading(csvText: string, columnSubstring: string): CsvReading | null {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  const header = splitCsvLine(lines[0]);
  const idx = header.findIndex((h) => h.toLowerCase().includes(columnSubstring.toLowerCase()));
  if (idx < 0) return null;

  const lastRow = splitCsvLine(lines[lines.length - 1]);
  const raw = lastRow[idx];
  const value = Number(raw);
  if (raw === undefined || Number.isNaN(value)) return null;

  return { value, dateTime: `${lastRow[0]} ${lastRow[1]}` };
}

/**
 * Tracks whether a value has been continuously at/above `threshold` for at
 * least `sustainedMs` — a single instantaneous spike shouldn't trigger
 * anything, only a value that stays there.
 */
export class SustainedThresholdTracker {
  private highSinceMs: number | null = null;

  constructor(
    private readonly threshold: number,
    private readonly sustainedMs: number,
  ) {}

  /** Feed one new reading; returns true the first time the sustained condition is met. */
  update(value: number, nowMs: number): boolean {
    if (value < this.threshold) {
      this.highSinceMs = null;
      return false;
    }
    if (this.highSinceMs === null) {
      this.highSinceMs = nowMs;
      return false;
    }
    return nowMs - this.highSinceMs >= this.sustainedMs;
  }

  reset(): void {
    this.highSinceMs = null;
  }
}

function usageAndExit(): never {
  console.error(
    'Usage: pnpm exec tsx scripts/gpu-thermal-watchdog.ts [--log <path>] [--column <substring>] ' +
      '[--threshold <celsius>] [--sustained-secs <N>] [--poll-ms <N>] [--kill-pid <PID>] [--dry-run]',
  );
  process.exit(2);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function findNewestPingTestContainer(): string | null {
  try {
    const out = execSync(
      "docker ps --format '{{.Names}}\\t{{.CreatedAt}}' | grep -i ping-test | sort -k2 -r | head -1",
      { encoding: 'utf-8', shell: '/bin/bash' },
    ).trim();
    return out ? out.split('\t')[0] : null;
  } catch {
    return null;
  }
}

function stopContainer(name: string): void {
  execSync(`docker stop ${JSON.stringify(name)}`, { stdio: 'inherit' });
}

// Kills the whole process group, not just the given PID, so run-crm-batch.sh
// and the run-bakeoff-test.sh child it's currently blocked on both die —
// killing only the parent would leave the child (and the docker container
// it's waiting on) running.
function killProcessGroup(pid: number): void {
  try {
    const pgid = execSync(`ps -o pgid= -p ${pid}`, { encoding: 'utf-8' }).trim();
    if (pgid) execSync(`kill -TERM -${pgid}`, { stdio: 'inherit' });
  } catch {
    // Already gone — nothing to do.
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) usageAndExit();

  const logPath = flagValue(args, '--log') ?? '/mnt/c/claude/hwinfo-logs/hwinfo-log.csv';
  const column = flagValue(args, '--column') ?? 'GPU Hot Spot Temperature';
  const threshold = Number(flagValue(args, '--threshold') ?? '100');
  const sustainedSecs = Number(flagValue(args, '--sustained-secs') ?? '30');
  const pollMs = Number(flagValue(args, '--poll-ms') ?? '5000');
  const killPid = flagValue(args, '--kill-pid');
  const dryRun = args.includes('--dry-run');

  console.log(
    `Watching ${logPath} for "${column}" >= ${threshold}°C sustained ${sustainedSecs}s ` +
      `(poll=${pollMs}ms, dry-run=${dryRun}, kill-pid=${killPid ?? 'none'})`,
  );

  const tracker = new SustainedThresholdTracker(threshold, sustainedSecs * 1000);
  let lastMtimeMs = 0;
  let lastStaleWarnAt = 0;

  for (;;) {
    try {
      const stat = statSync(logPath);
      if (stat.mtimeMs === lastMtimeMs) {
        const now = Date.now();
        if (lastMtimeMs !== 0 && now - lastStaleWarnAt > 60_000) {
          console.log(
            `  Warning: ${logPath} hasn't changed since ${new Date(lastMtimeMs).toISOString()} — is HWiNFO still logging?`,
          );
          lastStaleWarnAt = now;
        }
      }
      lastMtimeMs = stat.mtimeMs;

      const csvText = readFileSync(logPath, 'latin1');
      const reading = parseLatestReading(csvText, column);
      if (!reading) {
        console.log(`  Could not find column "${column}" or a valid reading in ${logPath}`);
      } else {
        const triggered = tracker.update(reading.value, Date.now());
        if (triggered) {
          console.log(
            `\n[THERMAL WATCHDOG] ${column} at ${reading.value}°C, sustained >= ${sustainedSecs}s ` +
              `(>= ${threshold}°C threshold) as of ${reading.dateTime} — stopping.`,
          );
          if (dryRun) {
            console.log('  (--dry-run: not stopping anything)');
          } else {
            const container = findNewestPingTestContainer();
            if (container) {
              console.log(`  Stopping container ${container}...`);
              stopContainer(container);
            } else {
              console.log('  No running ping-test container found to stop.');
            }
            if (killPid) {
              console.log(`  Killing process group for PID ${killPid}...`);
              killProcessGroup(Number(killPid));
            }
          }
          console.log('  Done. Exiting (one-shot — does not wait/resume automatically).');
          process.exit(2);
        }
      }
    } catch (err) {
      console.log(`  Error reading ${logPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

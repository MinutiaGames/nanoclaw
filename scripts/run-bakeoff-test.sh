#!/bin/bash
#
# Full test-run automation for the local-model bake-off (Phase 2). Replaces
# the manual multi-step dance repeated for every run: full session wipe,
# check OneCLI's still up, send the prompt, verify the spawned container is
# actually running the model .env claims, start the continuous watchdog,
# and poll for completion — a new outbound reply, the container exiting, a
# context-limit signal in its logs, a frozen heartbeat (possible hang), or
# the hard per-run time cap below.
# Prints the final reply and trajectory once it lands.
#
# Usage:
#   ./scripts/run-bakeoff-test.sh [--prompt "..."] [--group-id ID] [--session-id ID] [--hang-after-secs N] [--max-run-secs N]
#
# Defaults to the standard CPA-lookup bake-off prompt (kept identical
# across runs so results stay comparable — see nanoclaw-lead-gen-roadmap
# memory) and the fixed test group/session used throughout Phase 2.
#
# Safe to Ctrl-C: the watchdog it starts is killed via the EXIT trap either way.
#
# Hard time cap (added 2026-07-30 after the 100-run overnight batch): a
# healthy run averages ~4min and tops out around 7min (see
# crm-batch-timing-2026-07-29.md). 11 of 76 runs in that batch instead got
# stuck in a repeated-tool-call loop — one for 64 minutes — because the
# agent-watchdog below was warn-only. MAX_RUN_SECS is an unconditional
# wall-clock ceiling independent of the watchdog and the heartbeat check:
# even if the model is actively generating (heartbeat healthy, no context
# error yet) and the watchdog's loop detectors somehow don't fire, this
# still kills the container once the run runs long past what any real
# research task should ever take.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

GROUP_ID="ag-1785018768958-orewco"
SESSION_ID="sess-1785021772523-xez9ld"
HANG_AFTER_SECS=300 # 5min — frozen-heartbeat (true hang) check, tighter than MAX_RUN_SECS since a true hang has zero activity to justify waiting longer
MAX_RUN_SECS=600 # 10min hard cap — see rationale above
PROMPT="Find 5 CPAs (Certified Public Accountant credential) within 25 miles of zip code 52302, along with each one's phone number and email address. Do NOT search the web or use agent-browser yourself for this — instead use the delegate_web_research tool to hand off the actual research. Call it with a narrow, specific task description each time (you can call it once for the whole thing, or once per CPA, whichever gives clearer results). Once you get results back, compile a list: Name, City, Phone, Email (write 'not found' if you can't find it)."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt) PROMPT="$2"; shift 2 ;;
    --group-id) GROUP_ID="$2"; shift 2 ;;
    --session-id) SESSION_ID="$2"; shift 2 ;;
    --hang-after-secs) HANG_AFTER_SECS="$2"; shift 2 ;;
    --max-run-secs) MAX_RUN_SECS="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

SESS_DIR="data/v2-sessions/${GROUP_ID}/${SESSION_ID}"
INBOUND_DB="${SESS_DIR}/inbound.db"
OUTBOUND_DB="${SESS_DIR}/outbound.db"
HEARTBEAT="${SESS_DIR}/.heartbeat"

if [ ! -d "$SESS_DIR" ]; then
  echo "ERROR: session dir not found: $SESS_DIR" >&2
  exit 1
fi

echo "=== Full session wipe ==="
docker ps --format '{{.Names}}' | grep -i ping-test | xargs -r docker stop || true
rm -rf "${SESS_DIR}/opencode-xdg"
pnpm exec tsx scripts/q.ts "$OUTBOUND_DB" "DELETE FROM session_state WHERE key LIKE 'continuation%'" >/dev/null
# A run stopped mid-flight (e.g. after finding a bug worth fixing before
# resending) can leave its inbound message still 'pending' — the next fresh
# container would then pick that stale message up bundled together with the
# new one in the same batch, silently duplicating context. Clear pending
# rows so every run starts from a genuinely clean queue.
STALE_PENDING=$(pnpm exec tsx scripts/q.ts "$INBOUND_DB" "SELECT COUNT(*) FROM messages_in WHERE status = 'pending'")
if [ "$STALE_PENDING" -gt 0 ]; then
  echo "  clearing $STALE_PENDING stale pending inbound message(s) from an earlier interrupted run"
  pnpm exec tsx scripts/q.ts "$INBOUND_DB" "DELETE FROM messages_in WHERE status = 'pending'" >/dev/null
fi
LAST_SEQ=$(pnpm exec tsx scripts/q.ts "$OUTBOUND_DB" "SELECT COALESCE(MAX(seq), 0) FROM messages_out")
echo "  wiped, last outbound seq=$LAST_SEQ"

echo "=== Checking OneCLI gateway ==="
if ! docker ps --format '{{.Names}}' | grep -qx onecli; then
  echo "  onecli container not running — starting it (this has silently exited before after a Docker/WSL restart)"
  docker start onecli onecli-postgres-1 >/dev/null
  sleep 3
fi

echo "=== Sending prompt ==="
CHAT_LOG="$(mktemp)"
pnpm run chat "$PROMPT" > "$CHAT_LOG" 2>&1 &
disown
echo "  sent (client has its own 600s timeout and may report failure before the container actually finishes — ignored, see log at $CHAT_LOG)"

echo "=== Waiting for container to spawn ==="
CNAME=""
for _ in $(seq 1 15); do
  CNAME="$(docker ps --format '{{.Names}}' | grep -i ping-test | head -1 || true)"
  [ -n "$CNAME" ] && break
  sleep 2
done
if [ -z "$CNAME" ]; then
  echo "ERROR: no ping-test container appeared after 30s" >&2
  exit 1
fi
echo "  container: $CNAME"
docker inspect "$CNAME" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^OPENCODE_MODEL=|^OPENCODE_IDLE_TIMEOUT_MS=' | sed 's/^/  /'

echo "=== Starting watchdog ==="
WATCHDOG_LOG="$(mktemp)"
pnpm exec tsx scripts/agent-watchdog.ts "$SESS_DIR" --threshold 3 --escalating-threshold 3 --soft-threshold 6 --kill-on-escalating-retry --kill-on-soft-loop > "$WATCHDOG_LOG" 2>&1 &
WATCHDOG_PID=$!
trap 'kill "$WATCHDOG_PID" 2>/dev/null || true' EXIT
echo "  watchdog pid $WATCHDOG_PID, log at $WATCHDOG_LOG"

echo "=== Watching for completion ==="
RUN_START=$(date +%s)
while true; do
  if ! docker ps --format '{{.Names}}' | grep -qx "$CNAME"; then
    echo "RESULT: container exited"
    break
  fi
  ELAPSED=$(( $(date +%s) - RUN_START ))
  if [ "$ELAPSED" -gt "$MAX_RUN_SECS" ]; then
    echo "RESULT: hard timeout at ${ELAPSED}s (> ${MAX_RUN_SECS}s cap) — killing container"
    docker stop "$CNAME" >/dev/null 2>&1 || true
    break
  fi
  ERR="$(docker logs --tail 30 "$CNAME" 2>&1 | grep -iE 'context.{0,20}(length|limit|exceed|overflow)|too many tokens|maximum context' | tail -1 || true)"
  if [ -n "$ERR" ]; then
    echo "RESULT: context-limit signal: $ERR"
    break
  fi
  NEW_SEQ="$(pnpm exec tsx scripts/q.ts "$OUTBOUND_DB" "SELECT COALESCE(MAX(seq), 0) FROM messages_out" 2>/dev/null || echo "$LAST_SEQ")"
  if [ "$NEW_SEQ" -gt "$LAST_SEQ" ]; then
    echo "RESULT: new outbound message (seq=$NEW_SEQ)"
    break
  fi
  if [ -f "$HEARTBEAT" ]; then
    AGE=$(( $(date +%s) - $(stat -c '%Y' "$HEARTBEAT") ))
    if [ "$AGE" -gt "$HANG_AFTER_SECS" ]; then
      echo "RESULT: heartbeat frozen at ${AGE}s (> ${HANG_AFTER_SECS}s) — possible hang"
      docker stop "$CNAME" >/dev/null 2>&1 || true
      break
    fi
  fi
  sleep 20
done

echo ""
echo "=== Watchdog output ==="
cat "$WATCHDOG_LOG"

echo ""
echo "=== Final reply (seq > $LAST_SEQ) ==="
pnpm exec tsx scripts/q.ts "$OUTBOUND_DB" "SELECT content FROM messages_out WHERE seq > $LAST_SEQ ORDER BY seq"

echo ""
echo "=== Trajectory ==="
pnpm exec tsx scripts/trajectory.ts "$SESS_DIR"

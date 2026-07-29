#!/bin/bash
#
# Runs the standard CRM enrichment test prompt N times in a row (default 10).
# Each iteration calls run-bakeoff-test.sh, which does its own full session
# wipe (fresh container, fresh MCP process) and blocks in its own foreground
# loop until that run finishes — so this script just sequences N of those,
# nothing fancier. Not parallel: the test group/session is a single fixed
# target and the CRM/LM Studio are shared singletons.
#
# Usage: ./scripts/run-crm-batch.sh [N]
#
# Each run's full output (trajectory, tool calls, final reply) goes to
# logs/crm-batch/run-<i>-<timestamp>.log. A one-line-per-run entry is
# appended to logs/crm-batch/summary.log as each run finishes, so progress
# can be checked mid-batch without reading full logs. logs/ is gitignored.
#
# One bad/hung run does not abort the batch (set -e is deliberately not
# used) — a run that errors or times out is logged as FAILED and the batch
# continues to the next one.
#
# Progress reporting: also writes a live-ish status file to
# $STATUS_FILE (Windows-visible, since this whole pipeline is WSL2-side but
# the user has no console here) — overwritten on every update, not
# appended, since it's meant to answer "where are we right now", not be a
# history (logs/crm-batch/summary.log above already covers that). A
# background heartbeat loop refreshes it every 15s while a run is in
# flight, so "how far along is the CURRENT run" is visible too, not just
# completed-run boundaries.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

COUNT="${1:-10}"
OUT_DIR="logs/crm-batch"
mkdir -p "$OUT_DIR"
SUMMARY="$OUT_DIR/summary.log"

STATUS_DIR="/mnt/c/claude/runs"
mkdir -p "$STATUS_DIR" 2>/dev/null || true
STATUS_FILE="$STATUS_DIR/crm-batch-status.txt"

PROMPT="Use the crm_get_next_prospect tool (contact_type: referral_partner) to pick one CPA from the CRM who hasn't been researched yet. It will give you their real name, firm, and address already verified — do not question or re-derive that part. Then use web_search and web_fetch to research that specific person or firm: look for their firm's website, a public email or phone number, how long they've been in practice, and anything else useful (client reviews, specialties, social media). Don't bother fetching people-search/background-check sites (Whitepages, Spokeo, Radaris, BeenVerified, TruePeopleSearch, Intelius, MyLife, and similar) even if they show up in search results — those are paywalled and show masked placeholder data to non-subscribers, not real facts. When you're done researching, call crm_enrich_contact with their contact_id and ONLY the fields you actually found — leave a field out entirely if you couldn't find it, do not guess or invent a plausible-looking value. Put any freeform findings (years in business, review rating, etc.) in the signals object. Set status to 'researched' once you've made a genuine attempt, even if you found little. Then send me a short summary of what you found and saved."

BATCH_START="$(date -Iseconds)"
COMPLETED_LINES=()
CURRENT_STARTED_AT=""
HEARTBEAT_PID=""

write_status() {
  {
    echo "CRM batch status — updated $(date '+%Y-%m-%d %H:%M:%S')"
    echo "Batch started: $BATCH_START"
    echo "Progress: run ${CURRENT:-0}/$COUNT"
    if [ -n "$CURRENT_STARTED_AT" ]; then
      ELAPSED=$(( $(date +%s) - CURRENT_STARTED_AT ))
      echo "Currently running: run $CURRENT/$COUNT, started ${ELAPSED}s ago"
    else
      echo "Status: finished"
    fi
    echo ""
    echo "Completed runs:"
    if [ "${#COMPLETED_LINES[@]}" -eq 0 ]; then
      echo "  (none yet)"
    else
      for line in "${COMPLETED_LINES[@]}"; do echo "  $line"; done
    fi
  } > "$STATUS_FILE"
}

cleanup_heartbeat() {
  if [ -n "$HEARTBEAT_PID" ]; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
  fi
}
trap cleanup_heartbeat EXIT

echo "=== CRM batch: $COUNT runs starting $BATCH_START ===" | tee -a "$SUMMARY"
write_status

for i in $(seq 1 "$COUNT"); do
  CURRENT=$i
  CURRENT_STARTED_AT="$(date +%s)"
  write_status

  ( while true; do sleep 15; write_status; done ) &
  HEARTBEAT_PID=$!

  TS="$(date +%s)"
  LOGFILE="$OUT_DIR/run-${i}-${TS}.log"
  echo "--- Run $i/$COUNT starting $(date -Iseconds) -> $LOGFILE ---" | tee -a "$SUMMARY"

  ./scripts/run-bakeoff-test.sh --prompt "$PROMPT" > "$LOGFILE" 2>&1
  RC=$?

  cleanup_heartbeat
  HEARTBEAT_PID=""
  CURRENT_STARTED_AT=""

  if [ "$RC" -eq 0 ]; then
    STATUS="ok"
  else
    STATUS="FAILED (exit $RC)"
  fi
  RESULT_LINE="$(grep '^RESULT:' "$LOGFILE" | tail -1)"
  REPLY="$(sed -n '/=== Final reply/,/^$/p' "$LOGFILE" | tail -n +2 | tr '\n' ' ' | cut -c1-200)"

  echo "--- Run $i/$COUNT done: $STATUS | $RESULT_LINE | reply: $REPLY ---" | tee -a "$SUMMARY"
  COMPLETED_LINES+=("Run $i/$COUNT: $STATUS | $RESULT_LINE")
  write_status
done

CURRENT="$COUNT"
write_status
echo "=== CRM batch: $COUNT runs finished $(date -Iseconds) ===" | tee -a "$SUMMARY"

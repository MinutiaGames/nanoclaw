#!/bin/bash
#
# Runs the standard CRM enrichment test prompt N times in a row (default 10).
# Each iteration calls run-bakeoff-test.sh, which does its own full session
# wipe (fresh container, fresh MCP process) and blocks in its own foreground
# loop until that run finishes — so this script just sequences N of those,
# nothing fancier. Not parallel: the test group/session is a single fixed
# target and the CRM/LM Studio are shared singletons.
#
# Usage: ./scripts/run-crm-batch.sh [N] [--reload-every-mins N]
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
#
# Optional scheduled LM Studio reload: --reload-every-mins N. Confirmed
# 2026-08-02 on a real overnight batch: enrichment richness (signal field
# count/depth, not yield -- yield stayed ~98% the whole night) held steady
# for the first ~3.3h of continuous LM Studio uptime, then declined steadily
# to roughly a quarter of its starting depth by hour 6.5. Mechanism unclear
# (LM Studio's own reported "memory usage" figure was fluctuating by that
# point too, while dedicated GPU memory stayed rock-steady -- probably an
# unrelated reporting quirk, not the cause), but the timing correlation was
# clear enough to act on. If set, the batch checks elapsed time since the
# last reload (or batch start) only *between* runs -- it never interrupts a
# run in progress -- and if the interval has passed, pauses, unloads +
# reloads the currently-running model via lmstudio-reset.ps1 (bumped to 40
# load-attempt retries here, vs. that script's own default of 20, since an
# unattended overnight reload deserves more safety margin against the
# AMDVLK crash-on-load bug than an interactive one), then resumes.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

COUNT=10
RELOAD_EVERY_SECS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --reload-every-mins)
      RELOAD_EVERY_SECS=$(( $2 * 60 ))
      shift 2
      ;;
    --reload-every-mins=*)
      RELOAD_EVERY_SECS=$(( ${1#*=} * 60 ))
      shift
      ;;
    *)
      COUNT="$1"
      shift
      ;;
  esac
done

OUT_DIR="logs/crm-batch"
mkdir -p "$OUT_DIR"
SUMMARY="$OUT_DIR/summary.log"

STATUS_DIR="/mnt/c/claude/runs"
mkdir -p "$STATUS_DIR" 2>/dev/null || true
STATUS_FILE="$STATUS_DIR/crm-batch-status.txt"

# Overridable the same way container/agent-runner/src/mcp-tools/crm.ts's
# LEADGEN_CRM_BASE_URL is, for the DB cross-check added below.
CRM_DB_PATH="${LEADGEN_CRM_DB_PATH:-/mnt/c/claude/leadgen-crm/data/leadgen.db}"

PROMPT="Use the crm_get_next_prospect tool (contact_type: referral_partner, max_years_licensed: 5) to pick one CPA from the CRM who hasn't been researched yet and has been licensed 5 years or less — newer licensees are the current priority, don't omit this filter. It will give you their real name, firm, and address already verified — do not question or re-derive that part. Then use web_search and web_fetch to research that specific person or firm: look for their firm's website, a public email or phone number, how long they've been in practice, and anything else useful (client reviews, specialties, social media). Lead with your MOST specific search first — the full name in quotes plus \"CPA\" plus their city/state or license number — rather than a bare name search; a common first name or everyday word (e.g. \"Adam\", \"Jordan\", \"Cassandra\", \"Killian\") reliably pulls in unrelated pages (Wikipedia name/word entries, mythology, geography, brands) that have nothing to do with this person. If you notice that happening — results about the word/name itself rather than a CPA or a Florida license — that's your cue to stop, not to keep rephrasing the same search. Cap yourself at 3 web_search calls for this contact: if none of them turn up a clearly-matching, individual result, stop searching entirely and call crm_enrich_contact right away with just the CRM-provided fields, status 'researched', and a note like \"common name/no individual web footprint found\" — do not keep retrying variations of the same query. A contact saved with minimal info beats one left unresearched because search never found a good angle. Don't bother fetching people-search/background-check sites (Whitepages, Spokeo, Radaris, BeenVerified, TruePeopleSearch, Intelius, MyLife, and similar) even if they show up in search results — those are paywalled and show masked placeholder data to non-subscribers, not real facts. Same goes for LinkedIn personal-profile URLs (linkedin.com/in/...) — web_fetch refuses these outright since they always hit a login wall; use the snippet text web_search already gave you for that result instead of trying to fetch the page. LinkedIn company pages (linkedin.com/company/...) are fine to fetch and often have real info. When you're done researching, call crm_enrich_contact with their contact_id and ONLY the fields you actually found — leave a field out entirely if you couldn't find it, do not guess or invent a plausible-looking value. Put any freeform findings (years in business, review rating, etc.) in the signals object. Set status to 'researched' once you've made a genuine attempt, even if you found little. Then send me a short summary of what you found and saved."

RELOAD_MAX_LOAD_ATTEMPTS=40

BATCH_START="$(date -Iseconds)"
COMPLETED_LINES=()
CURRENT_STARTED_AT=""
HEARTBEAT_PID=""
LAST_RELOAD_TS="$(date +%s)"
RELOAD_STATUS_NOTE=""

write_status() {
  {
    echo "CRM batch status — updated $(date '+%Y-%m-%d %H:%M:%S')"
    echo "Batch started: $BATCH_START"
    echo "Progress: run ${CURRENT:-0}/$COUNT"
    if [ -n "$RELOAD_STATUS_NOTE" ]; then
      echo "$RELOAD_STATUS_NOTE"
    elif [ -n "$CURRENT_STARTED_AT" ]; then
      ELAPSED=$(( $(date +%s) - CURRENT_STARTED_AT ))
      echo "Currently running: run $CURRENT/$COUNT, started ${ELAPSED}s ago"
    else
      echo "Status: finished"
    fi
    if [ -n "$RELOAD_EVERY_SECS" ]; then
      NEXT_RELOAD_IN=$(( RELOAD_EVERY_SECS - ($(date +%s) - LAST_RELOAD_TS) ))
      echo "Next scheduled LM Studio reload: in ${NEXT_RELOAD_IN}s (every $((RELOAD_EVERY_SECS / 60))min)"
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

# Queries LM Studio (Windows-side, via powershell.exe interop) for the
# currently-loaded model's identifier. Deliberately has no hardcoded
# fallback -- if this can't be determined, reload_lm_studio_model aborts
# the batch rather than guessing which model to reload.
get_loaded_model() {
  # 'lms ps' output has been observed both with and without a leading blank
  # line before the header (Windows-side CLI buffering quirk, not
  # reproducible on demand) -- anchor on the literal header row instead of
  # a fixed line number so a stray leading blank line can't misalign it.
  powershell.exe -NoProfile -Command '& "$env:USERPROFILE\.lmstudio\bin\lms.exe" ps' 2>/dev/null \
    | tr -d '\r' \
    | awk '/^IDENTIFIER/{found=1; next} found && NF {print $1; exit}'
}

# Pauses the batch, unloads + reloads the currently-running LM Studio model
# via the brute-force retry script, then returns. Only ever called between
# runs (see the main loop below) -- never interrupts a run in progress.
reload_lm_studio_model() {
  local model
  model="$(get_loaded_model)"
  if [ -z "$model" ]; then
    echo "--- Scheduled LM Studio reload ABORTED: could not determine the currently-loaded model via 'lms ps' -- aborting batch rather than guessing ---" | tee -a "$SUMMARY"
    exit 1
  fi

  echo "--- Scheduled LM Studio reload: pausing batch, reloading '$model' (max $RELOAD_MAX_LOAD_ATTEMPTS load attempts) ---" | tee -a "$SUMMARY"
  RELOAD_STATUS_NOTE="PAUSED for scheduled LM Studio reload (model: $model)"
  write_status

  local reset_script_win
  reset_script_win="$(wslpath -w "$SCRIPT_DIR/lmstudio-reset.ps1")"
  powershell.exe -ExecutionPolicy Bypass -File "$reset_script_win" -Model "$model" -MaxLoadAttempts "$RELOAD_MAX_LOAD_ATTEMPTS"
  local rc=$?

  if [ "$rc" -ne 0 ]; then
    echo "--- Scheduled LM Studio reload FAILED (exit $rc) -- aborting batch, LM Studio may be in a bad state ---" | tee -a "$SUMMARY"
    RELOAD_STATUS_NOTE="FAILED scheduled LM Studio reload -- batch aborted, check LM Studio manually"
    write_status
    exit 1
  fi

  echo "--- Scheduled LM Studio reload complete, resuming batch ---" | tee -a "$SUMMARY"
  RELOAD_STATUS_NOTE=""
  LAST_RELOAD_TS="$(date +%s)"
}

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

  RUN_START_ISO="$(date -u +%Y-%m-%dT%H:%M:%S)"
  ./scripts/run-bakeoff-test.sh --prompt "$PROMPT" > "$LOGFILE" 2>&1
  RC=$?
  RUN_END_ISO="$(date -u +%Y-%m-%dT%H:%M:%S)"

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

  # The harness's own RESULT line isn't a trustworthy success/failure signal by
  # itself -- "container exited" fires whenever docker ps notices the container
  # gone without a clean completion signal, but says nothing about whether
  # crm_enrich_contact actually landed (real incident, 2026-08-03: 4/6
  # "container exited" runs that session had actually saved successfully, just
  # without a final chat reply). Cross-check the CRM DB directly for a contact
  # updated during this run's real wall-clock window instead of trusting the
  # log label alone.
  DB_CHECK="$(pnpm exec tsx scripts/q.ts "$CRM_DB_PATH" \
    "SELECT id, status, name FROM contacts WHERE datetime(updated_at) >= datetime('$RUN_START_ISO') AND datetime(updated_at) <= datetime('$RUN_END_ISO', '+5 seconds') ORDER BY updated_at DESC LIMIT 1" 2>/dev/null)"
  if [ -n "$DB_CHECK" ]; then
    DB_NOTE="DB: saved contact $DB_CHECK"
  else
    DB_NOTE="DB: no contact saved in this window"
  fi

  echo "--- Run $i/$COUNT done: $STATUS | $RESULT_LINE | $DB_NOTE | reply: $REPLY ---" | tee -a "$SUMMARY"
  COMPLETED_LINES+=("Run $i/$COUNT: $STATUS | $RESULT_LINE | $DB_NOTE")
  write_status

  if [ -n "$RELOAD_EVERY_SECS" ] && [ "$i" -lt "$COUNT" ]; then
    NOW="$(date +%s)"
    if (( NOW - LAST_RELOAD_TS >= RELOAD_EVERY_SECS )); then
      reload_lm_studio_model
    fi
  fi
done

CURRENT="$COUNT"
write_status
echo "=== CRM batch: $COUNT runs finished $(date -Iseconds) ===" | tee -a "$SUMMARY"

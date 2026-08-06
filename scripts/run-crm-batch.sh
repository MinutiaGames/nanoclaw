#!/bin/bash
#
# Runs the standard CRM enrichment test prompt N times in a row (default 10).
# Each iteration calls run-bakeoff-test.sh, which does its own full session
# wipe (fresh container, fresh MCP process) and blocks in its own foreground
# loop until that run finishes — so this script just sequences N of those,
# nothing fancier. Not parallel: the test group/session is a single fixed
# target and the CRM/LM Studio are shared singletons.
#
# Usage: ./scripts/run-crm-batch.sh [N] [--reload-every-mins N] [--phase2]
#
# --phase2 switches the embedded prompt from phase 1 (crm_get_next_prospect
# -> research -> save status 'researched', grows the researched pool) to
# phase 2 (crm_get_phase2_candidates -> research -> save status 'potential'/
# 'not_viable', decides who's actually worth pursuing from what's already
# researched). Mostly a prompt swap — reload scheduling and the DB-verify
# cross-check apply identically to both, since both are still "one agent,
# one contact, one enrich call per run" — but two things are ALSO tuned
# differently for --phase2 (see WATCHDOG_ESCALATING_THRESHOLD/
# WATCHDOG_SOFT_THRESHOLD/RUN_MAX_SECS below): the watchdog's escalating-
# retry/soft-loop thresholds are raised, because phase 2's higher 6-call
# search cap naturally produces same-contact-name-prefixed calls that would
# otherwise trip those detectors on legitimate behavior; and the hard
# per-run timeout is raised, because phase 2 runs longer by design (6
# web_search calls vs phase 1's 3, plus more web_fetch) and phase 1's
# 600s/10min cap sits uncomfortably close to phase 2's own observed
# 6-9.5min range. Full prompt text + design rationale: scripts/crm-test-prompt-history.md.
# The two phases are meant to be run on alternating nights, not simultaneously
# — phase 2 only ever touches contacts phase 1 already finished with.
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
PHASE2=""
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
    --phase2)
      PHASE2="1"
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

PROMPT_PHASE1="Use the crm_get_next_prospect tool (contact_type: referral_partner, max_years_licensed: 5) to pick one CPA from the CRM who hasn't been researched yet and has been licensed 5 years or less — newer licensees are the current priority, don't omit this filter. It will give you their real name, firm, and address already verified — do not question or re-derive that part. Then use web_search and web_fetch to research that specific person or firm: look for their firm's website, a public email or phone number, how long they've been in practice, and anything else useful (client reviews, specialties, social media). Lead with your MOST specific search first — the full name in quotes plus \"CPA\" plus their city/state or license number — rather than a bare name search; a common first name or everyday word (e.g. \"Adam\", \"Jordan\", \"Cassandra\", \"Killian\") reliably pulls in unrelated pages (Wikipedia name/word entries, mythology, geography, brands) that have nothing to do with this person. If you notice that happening — results about the word/name itself rather than a CPA or a Florida license — that's your cue to stop, not to keep rephrasing the same search. Cap yourself at 3 web_search calls for this contact: if none of them turn up a clearly-matching, individual result, stop searching entirely and call crm_enrich_contact right away with just the CRM-provided fields, status 'researched', and a note like \"common name/no individual web footprint found\" — do not keep retrying variations of the same query. A contact saved with minimal info beats one left unresearched because search never found a good angle. Don't bother fetching people-search/background-check sites (Whitepages, Spokeo, Radaris, BeenVerified, TruePeopleSearch, Intelius, MyLife, and similar) even if they show up in search results — those are paywalled and show masked placeholder data to non-subscribers, not real facts. Same goes for LinkedIn personal-profile URLs (linkedin.com/in/...) — web_fetch refuses these outright since they always hit a login wall; use the snippet text web_search already gave you for that result instead of trying to fetch the page. LinkedIn company pages (linkedin.com/company/...) are fine to fetch and often have real info. When you're done researching, call crm_enrich_contact with their contact_id and ONLY the fields you actually found — leave a field out entirely if you couldn't find it, do not guess or invent a plausible-looking value. Put any freeform findings (years in business, review rating, etc.) in the signals object. Set status to 'researched' once you've made a genuine attempt, even if you found little. Then send me a short summary of what you found and saved."

PROMPT_PHASE2="Use the crm_get_phase2_candidates tool (contact_type: referral_partner) to pull 5 already-researched CPAs from the CRM. Using ONLY the information already returned for each of the 5 — do not search the web yet — pick the single most promising one as a referral-partner candidate: favor whoever looks strongest on audience fit and reach (years_in_business, client_count_est, review_rating/review_count, accepting_new_clients, any notes hinting at trade-client work). If several look similar, picking any reasonable one is fine, this is a coarse triage not a precise ranking. Then research ONLY that one contact — leave the other 4 completely untouched, they go back in the pool for a future run. Look specifically for: (1) whether the firm offers bookkeeping services itself — check the site's nav/services list for anything like \"Bookkeeping Services\"; if you see it, open that SPECIFIC page and read it, don't just infer from the label or move on. If the page describes them doing the bookkeeping work themselves (their own staff/process, no mention of outsourcing or referring it elsewhere), that's a hard disqualifier — they're a competitor, not a referral source. Only treat it as NOT disqualifying if the page explicitly says they outsource or refer bookkeeping to another firm/partner. If that specific page 404s or won't load but bookkeeping is still listed as one of their services elsewhere on the site (nav, homepage, service list), default to treating it as in-house and disqualify rather than leaving it unresolved — a firm advertising a service on its own site is offering it themselves unless stated otherwise; (2) whether the firm explicitly states it doesn't make referrals to other professionals — rare, but also a hard disqualifier if found; (3) whether the firm serves trade/contractor clients (HVAC, plumbing, electrical, construction) — check their site's services/\"who we serve\" page, case studies, testimonials; this is the strongest positive signal, actively look for it. Note: a firm NOT currently accepting new clients is NOT by itself a hard disqualifier — they can still be a great referral source, possibly even more motivated to refer people elsewhere since they can't take them on directly; only the two items in (1) and (2) above are hard disqualifiers. Also try to fill in any gaps in years_in_business, client_count_est, review_rating/review_count, accepting_new_clients, or social_handles if phase 1 left them blank. You get AT MOST 6 web_search calls AND AT MOST 6 web_fetch calls total for this contact — count them as you go. These caps are now enforced mechanically, not just by this instruction: the moment you go over either one, that tool returns a budget-exceeded message instead of actually performing the call, so don't wait to self-regulate — stop as soon as you hit 6 of either and move to the verdict/save step with whatever you have, even if something's still unconfirmed. You have more room here than phase 1 because you're going deeper on one already-verified entity instead of finding one from scratch, so use the budget to actually cover the distinct things listed above (website, in-house-bookkeeping check, no-referral check, trade-client evidence, reviews, gap-filling) rather than repeating variations of the same query. Each call should be going after a genuinely different piece of information. Watch for a specific trap: a firm's name or the person's first name can collide with something totally unrelated (a large company with a similar name, a common first name pulling generic web results, a different business entirely) — if you notice your results are actually about that OTHER thing rather than the specific firm/person you're researching, that is your cue to stop searching and decide with what you have, not to keep rephrasing the query hoping the next one lands — plausible-looking results about the wrong entity are not progress. If you hit a budget cap and genuinely believe more research would change the verdict, don't guess: call crm_enrich_contact with signals.needs_more_research=true and status left at 'researched' (not a final verdict) instead of forcing potential/not_viable on incomplete information — a future phase-2 run will pick this contact back up first, with its own full budget, so nothing you've already found is wasted. Otherwise, call crm_enrich_contact for ONLY your chosen contact_id: set status to 'potential' if no hard disqualifier was found and there's a real positive signal (especially trade-client evidence), or 'not_viable' if a hard disqualifier was found or there's simply no positive signal to justify pursuing them. Save offers_bookkeeping_inhouse, explicit_no_referral, and serves_trade_clients as true/false in signals, plus whatever else you found. Put your reasoning for the verdict in note — write it so a human can understand the call without re-deriving it. YOU MUST ACTUALLY CALL crm_enrich_contact BEFORE REPLYING — a verdict written only in your reply to me is not saved anywhere in the CRM and will be lost; do not consider this task finished until that tool call has been made. Then send me a short summary: which contact you picked and why, your verdict (or that you flagged it for more research), and one line on why you passed on each of the other 4 based on what was already known about them."

if [ -n "$PHASE2" ]; then
  PROMPT="$PROMPT_PHASE2"
  PHASE_LABEL="phase2"
  # Phase 2's prompt (above) has the model searching the SAME contact's name
  # up to 6 times in a row for different topics -- those calls naturally
  # share a long argument prefix (the contact's name), which is exactly the
  # shape agent-watchdog.ts's escalating-retry and same-tool-streak
  # detectors key on. At phase 1's defaults (escalating=3, soft=6) a fully
  # legitimate, cap-respecting phase-2 run would get auto-killed by its OWN
  # correct behavior -- raised here with a few calls of headroom above the
  # 6-call cap so the real backstop (a genuinely runaway loop well past what
  # the prompt asks for) still fires. See crm-test-prompt-history.md.
  WATCHDOG_ESCALATING_THRESHOLD=8
  WATCHDOG_SOFT_THRESHOLD=9
  # run-bakeoff-test.sh's own MAX_RUN_SECS default (600s/10min) was tuned to
  # phase 1's observed ~4min avg/7min max. Phase 2 runs longer by design (up
  # to 6 web_search calls vs phase 1's 3, plus more web_fetch calls) --
  # observed 6-9.5min across the first three live single runs, uncomfortably
  # close to the 600s ceiling. Raised to 780s (13min) for real margin, while
  # staying safely under the container's own internal 900s (15min)
  # OPENCODE_IDLE_TIMEOUT_MS so the two don't race each other.
  RUN_MAX_SECS=780
else
  PROMPT="$PROMPT_PHASE1"
  PHASE_LABEL="phase1"
  WATCHDOG_ESCALATING_THRESHOLD=3
  WATCHDOG_SOFT_THRESHOLD=6
  RUN_MAX_SECS=600
fi

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
  ./scripts/run-bakeoff-test.sh --prompt "$PROMPT" \
    --escalating-threshold "$WATCHDOG_ESCALATING_THRESHOLD" --soft-threshold "$WATCHDOG_SOFT_THRESHOLD" \
    --max-run-secs "$RUN_MAX_SECS" \
    > "$LOGFILE" 2>&1
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

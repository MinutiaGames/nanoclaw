/**
 * Mechanical per-run search/fetch budget for the CRM phase-2 pipeline.
 *
 * Phase 2's own prompt has always said "AT MOST 6 web_search calls" as a
 * soft instruction, but two real failure modes showed that's not enough on
 * its own: run 5 (a fully legitimate 9-fetch multi-page investigation) got
 * killed as a false positive by the watchdog's escalating-retry detector,
 * while run 97 (11 web_search calls chasing a name it couldn't spell
 * consistently) only got caught because the watchdog eventually fired
 * anyway — the same fixed threshold can't tell the two apart, and a
 * watchdog kill throws away whatever the run had already found. This module
 * enforces the cap directly instead: the (N+1)th web_search/web_fetch call
 * for a contact is never actually performed — the tool returns a message
 * telling the model to stop and either save its verdict now, or, if it
 * genuinely believes more research is needed, flag the contact via
 * crm_enrich_contact's `needs_more_research` signal (see crm.ts and
 * leadgen-crm's db/migrations/0004) instead of guessing. A future phase-2
 * run then picks that contact back up with a fresh budget, so a hard stop
 * here never loses already-gathered findings the way a watchdog kill does.
 *
 * Phase 1 is deliberately NOT capped here — it already has its own
 * validated soft cap (prompt v5, 3 web_search calls) at 98%+ yield with no
 * comparable failure mode observed, so mechanizing an already-working
 * policy would add risk for no evidenced benefit. crm_get_next_prospect
 * still calls setResearchPhase('phase1') below, which leaves both caps at
 * null (no-op) but resets the counters — defensive, not currently load-
 * bearing, since each run is a fresh container anyway.
 *
 * Plain in-process module state, not persisted anywhere — same idiom as
 * the SearXNG-failure counter in web-tools.ts. This is safe specifically
 * because the agent-runner process is per-run (one CRM enrichment attempt
 * per container, confirmed in run-bakeoff-test.sh), so state here can
 * never leak between contacts or between runs.
 */

export type ResearchPhase = 'phase1' | 'phase2';

const PHASE2_WEB_SEARCH_CAP = 6;
const PHASE2_WEB_FETCH_CAP = 6;

interface Budget {
  phase: ResearchPhase;
  webSearchCap: number | null;
  webFetchCap: number | null;
}

let budget: Budget | null = null;
let webSearchCount = 0;
let webFetchCount = 0;

export function setResearchPhase(phase: ResearchPhase): void {
  budget =
    phase === 'phase2'
      ? { phase, webSearchCap: PHASE2_WEB_SEARCH_CAP, webFetchCap: PHASE2_WEB_FETCH_CAP }
      : { phase, webSearchCap: null, webFetchCap: null };
  webSearchCount = 0;
  webFetchCount = 0;
}

/** Test-only: this module's state is otherwise process-lifetime, which would leak between test cases. */
export function __resetResearchBudgetForTests(): void {
  budget = null;
  webSearchCount = 0;
  webFetchCount = 0;
}

const NEEDS_MORE_RESEARCH_HINT =
  "If you genuinely believe more research would change the verdict, don't guess — call crm_enrich_contact now with signals.needs_more_research=true and status left at 'researched' (not a final verdict). A future phase-2 run will pick this contact back up with its own fresh search/fetch budget, so nothing you've already found is lost.";

/**
 * Call once per web_search invocation, before doing any real work. Returns
 * a budget-exceeded message (and does NOT increment past the cap) once the
 * call count exceeds this phase's cap; returns null when the call is
 * within budget (or this phase has no cap) and should proceed normally.
 */
export function checkWebSearchBudget(): string | null {
  if (!budget || budget.webSearchCap === null) return null;
  webSearchCount++;
  if (webSearchCount <= budget.webSearchCap) return null;
  return (
    `web_search budget exceeded (${budget.webSearchCap} calls already used for this contact) — this search was NOT performed. ` +
    `Stop searching now and save your verdict with what you already have. ${NEEDS_MORE_RESEARCH_HINT}`
  );
}

/** Same contract as checkWebSearchBudget, for web_fetch. */
export function checkWebFetchBudget(): string | null {
  if (!budget || budget.webFetchCap === null) return null;
  webFetchCount++;
  if (webFetchCount <= budget.webFetchCap) return null;
  return (
    `web_fetch budget exceeded (${budget.webFetchCap} calls already used for this contact) — this page was NOT fetched. ` +
    `Stop fetching now and save your verdict with what you already have. ${NEEDS_MORE_RESEARCH_HINT}`
  );
}

# CRM enrichment test prompt — version history

`scripts/run-crm-batch.sh` has never been committed until 2026-07-28, so git
history doesn't have earlier versions of the embedded prompt — kept here
instead so we can backtrack if a future change makes results worse, not
better.

## v5 — current (2026-08-01, this is what's live in run-crm-batch.sh)

Added after diagnosing a 1000-run overnight batch (killed early by the user
at run 255): 181/255 runs (71%) ended with nothing saved, and of those,
**180/181 never even called `crm_enrich_contact`** — the loop-detector's
soft-loop/escalating-retry auto-kill was doing exactly its job (from the
2026-07-30 fix), but the model was giving it something to catch on almost
every difficult contact. Root cause, confirmed by reading the reasoning
trace across a broad sample of the failures (not guessed): a common first
name or everyday word (Adam, Jordan, Cassandra, Killian, Beata...) pulls in
unrelated pages (Bible, mythology, a country, a perfume brand, a
Wikipedia name-origin entry), the model's own reasoning correctly
identifies this ("results about the word 'Jordan' instead of the CPA"),
but then it just reformulates a near-identical query 5-6 times instead of
either leading with a sharper query or giving up and saving partial data.
Confirmed NOT an infra issue: SearXNG/Serper were returning real, relevant
results throughout (only 6/181 mentioned any HTTP error/block, all
incidental single-site issues), GPU stayed thermally stable all night, and
contact selection is `ORDER BY RANDOM()` so it isn't pulling easy contacts
first. Two changes: (1) tells the model to lead with its most specific
query (quoted full name + "CPA" + city/state or license number) instead of
a bare name search, and explicitly names the common-name-collision pattern
so it's recognized as a stop signal rather than a rephrase signal; (2) caps
effort at 3 `web_search` calls per contact — past that, stop and save
whatever's known (CRM fields + status `researched` + a note) rather than
keep retrying. 3 was chosen to land under the loop-detector's own
escalating-retry threshold (3) so the model should self-regulate before the
watchdog ever needs to step in. Not yet validated against a real batch —
see `HANDOFF.md` for the next-session plan to test this.

```
Use the crm_get_next_prospect tool (contact_type: referral_partner, max_years_licensed: 5) to pick one CPA from the CRM who hasn't been researched yet and has been licensed 5 years or less — newer licensees are the current priority, don't omit this filter. It will give you their real name, firm, and address already verified — do not question or re-derive that part. Then use web_search and web_fetch to research that specific person or firm: look for their firm's website, a public email or phone number, how long they've been in practice, and anything else useful (client reviews, specialties, social media). Lead with your MOST specific search first — the full name in quotes plus "CPA" plus their city/state or license number — rather than a bare name search; a common first name or everyday word (e.g. "Adam", "Jordan", "Cassandra", "Killian") reliably pulls in unrelated pages (Wikipedia name/word entries, mythology, geography, brands) that have nothing to do with this person. If you notice that happening — results about the word/name itself rather than a CPA or a Florida license — that's your cue to stop, not to keep rephrasing the same search. Cap yourself at 3 web_search calls for this contact: if none of them turn up a clearly-matching, individual result, stop searching entirely and call crm_enrich_contact right away with just the CRM-provided fields, status 'researched', and a note like "common name/no individual web footprint found" — do not keep retrying variations of the same query. A contact saved with minimal info beats one left unresearched because search never found a good angle. Don't bother fetching people-search/background-check sites (Whitepages, Spokeo, Radaris, BeenVerified, TruePeopleSearch, Intelius, MyLife, and similar) even if they show up in search results — those are paywalled and show masked placeholder data to non-subscribers, not real facts. Same goes for LinkedIn personal-profile URLs (linkedin.com/in/...) — web_fetch refuses these outright since they always hit a login wall; use the snippet text web_search already gave you for that result instead of trying to fetch the page. LinkedIn company pages (linkedin.com/company/...) are fine to fetch and often have real info. When you're done researching, call crm_enrich_contact with their contact_id and ONLY the fields you actually found — leave a field out entirely if you couldn't find it, do not guess or invent a plausible-looking value. Put any freeform findings (years in business, review rating, etc.) in the signals object. Set status to 'researched' once you've made a genuine attempt, even if you found little. Then send me a short summary of what you found and saved.
```

## v4 (2026-07-29 – 2026-08-01, superseded by v5 above)

Added a LinkedIn-specific line after confirming (across every batch run so
far) that a bare `web_fetch` of a `linkedin.com/in/...` profile URL always
hits a login wall or an HTTP 999 anti-bot block — never real content.
`web_fetch` itself now mechanically refuses `/in/` URLs
(`container/agent-runner/src/mcp-tools/web-tools.ts`,
`isLinkedInProfilePath`), same pattern as the people-search-site refusal;
this prompt line just saves the model a wasted round-trip by telling it not
to bother. Company pages (`linkedin.com/company/...`) are NOT blocked —
they've returned real About/website/employee data live — and the
search-result snippet for a profile URL usually already has the useful
bio/title/company text anyway.

```
Use the crm_get_next_prospect tool (contact_type: referral_partner, max_years_licensed: 5) to pick one CPA from the CRM who hasn't been researched yet and has been licensed 5 years or less — newer licensees are the current priority, don't omit this filter. It will give you their real name, firm, and address already verified — do not question or re-derive that part. Then use web_search and web_fetch to research that specific person or firm: look for their firm's website, a public email or phone number, how long they've been in practice, and anything else useful (client reviews, specialties, social media). Don't bother fetching people-search/background-check sites (Whitepages, Spokeo, Radaris, BeenVerified, TruePeopleSearch, Intelius, MyLife, and similar) even if they show up in search results — those are paywalled and show masked placeholder data to non-subscribers, not real facts. Same goes for LinkedIn personal-profile URLs (linkedin.com/in/...) — web_fetch refuses these outright since they always hit a login wall; use the snippet text web_search already gave you for that result instead of trying to fetch the page. LinkedIn company pages (linkedin.com/company/...) are fine to fetch and often have real info. When you're done researching, call crm_enrich_contact with their contact_id and ONLY the fields you actually found — leave a field out entirely if you couldn't find it, do not guess or invent a plausible-looking value. Put any freeform findings (years in business, review rating, etc.) in the signals object. Set status to 'researched' once you've made a genuine attempt, even if you found little. Then send me a short summary of what you found and saved.
```

## v3 (2026-07-29, superseded by v4 above)

Narrowed selection from "any unresearched referral partner" to "unresearched
AND licensed 5 years or fewer" via the new `max_years_licensed` param on
`crm_get_next_prospect` (CRM: `getNextProspect`'s `max_years_licensed` filter;
NanoClaw: the MCP tool's new schema field). With 40k+ contacts and most not
worth enriching yet, this is the first cut of prioritizing the pool instead
of picking a purely random contact — newer licensees are the current focus.
7,480 of 39,997 unresearched referral partners matched this threshold as of
2026-07-29 (~18.7% of the pool).

```
Use the crm_get_next_prospect tool (contact_type: referral_partner, max_years_licensed: 5) to pick one CPA from the CRM who hasn't been researched yet and has been licensed 5 years or less — newer licensees are the current priority, don't omit this filter. It will give you their real name, firm, and address already verified — do not question or re-derive that part. Then use web_search and web_fetch to research that specific person or firm: look for their firm's website, a public email or phone number, how long they've been in practice, and anything else useful (client reviews, specialties, social media). Don't bother fetching people-search/background-check sites (Whitepages, Spokeo, Radaris, BeenVerified, TruePeopleSearch, Intelius, MyLife, and similar) even if they show up in search results — those are paywalled and show masked placeholder data to non-subscribers, not real facts. When you're done researching, call crm_enrich_contact with their contact_id and ONLY the fields you actually found — leave a field out entirely if you couldn't find it, do not guess or invent a plausible-looking value. Put any freeform findings (years in business, review rating, etc.) in the signals object. Set status to 'researched' once you've made a genuine attempt, even if you found little. Then send me a short summary of what you found and saved.
```

## v2 (2026-07-28 – 2026-07-29, superseded by v3 above)

Added the paywall-avoidance line after the Steven Schindler/Spokeo garbage-data
incident (run 6 of the day) — the model doesn't need to try these sites at all
now that `web_fetch` refuses them outright, but telling it not to bother saves
a wasted tool call each time one shows up in search results.

```
Use the crm_get_next_prospect tool (contact_type: referral_partner) to pick one CPA from the CRM who hasn't been researched yet. It will give you their real name, firm, and address already verified — do not question or re-derive that part. Then use web_search and web_fetch to research that specific person or firm: look for their firm's website, a public email or phone number, how long they've been in practice, and anything else useful (client reviews, specialties, social media). Don't bother fetching people-search/background-check sites (Whitepages, Spokeo, Radaris, BeenVerified, TruePeopleSearch, Intelius, MyLife, and similar) even if they show up in search results — those are paywalled and show masked placeholder data to non-subscribers, not real facts. When you're done researching, call crm_enrich_contact with their contact_id and ONLY the fields you actually found — leave a field out entirely if you couldn't find it, do not guess or invent a plausible-looking value. Put any freeform findings (years in business, review rating, etc.) in the signals object. Set status to 'researched' once you've made a genuine attempt, even if you found little. Then send me a short summary of what you found and saved.
```

## v1 — original (used for runs 1-6 of the day, before the paywall line)

```
Use the crm_get_next_prospect tool (contact_type: referral_partner) to pick one CPA from the CRM who hasn't been researched yet. It will give you their real name, firm, and address already verified — do not question or re-derive that part. Then use web_search and web_fetch to research that specific person or firm: look for their firm's website, a public email or phone number, how long they've been in practice, and anything else useful (client reviews, specialties, social media). When you're done researching, call crm_enrich_contact with their contact_id and ONLY the fields you actually found — leave a field out entirely if you couldn't find it, do not guess or invent a plausible-looking value. Put any freeform findings (years in business, review rating, etc.) in the signals object. Set status to 'researched' once you've made a genuine attempt, even if you found little. Then send me a short summary of what you found and saved.
```

## Phase 2 — deeper research (crm_get_phase2_candidates)

Everything above this section is phase 1 (`crm_get_next_prospect` — finds
basic contact info on an unresearched contact at volume). Phase 2 is a
separate, later pass: it draws 5 random already-`researched` contacts via
`crm_get_phase2_candidates`, picks the most promising one using only what
phase 1 already found, then researches ONLY that one for referral-partner
viability (in-house-bookkeeping competitor check, explicit-no-referral
check, trade-client evidence) and saves a `potential`/`not_viable` verdict.
Deliberately a separate prompt track, not a version of the phase-1 prompt
above — see `project_nanoclaw_outreach_strategy` memory and `HANDOFF.md`
for the full design discussion (2026-08-05).

### v1 — current (2026-08-05, this is what's live in run-crm-batch.sh's PROMPT_PHASE2)

Search cap set at 6 web_search calls, not phase 1's 3 — deliberately higher
because a phase-2 run is going deeper on ONE already-verified entity across
several distinct topics (firm website, in-house-bookkeeping check,
no-referral check, trade-client evidence, reviews, gap-filling) rather than
finding one contact from scratch. Raised together with, not instead of, the
anti-loop discipline: the prompt explicitly tells the model each call
should target a genuinely different piece of information, and that
rephrasing an already-empty query is the cue to stop, not keep going.

**Watchdog thresholds raised to match, not left at phase-1 defaults.**
Because every phase-2 web_search call is about the SAME contact's name,
consecutive calls naturally share a long argument prefix (e.g. `{"query":
"Acme CPA Jacksonville FL ...`) — exactly the shape
`detectEscalatingRetry` (agent-watchdog.ts) keys on, and
`detectSameToolStreak` fires on any N-in-a-row same-tool calls regardless
of content. At phase 1's tight defaults (escalating-threshold=3,
soft-threshold=6) a phase-2 run that behaved EXACTLY as instructed — 6
distinct, on-topic searches about one contact — would still get
auto-killed by its own correct behavior, since 6 same-contact calls hits
the soft-threshold exactly and very likely trips the prefix-overlap check
well before that. `run-bakeoff-test.sh` gained `--escalating-threshold`/
`--soft-threshold` flags (defaults unchanged at 3/6, so phase 1 is
unaffected) and `run-crm-batch.sh` passes 8/9 for `--phase2` runs — a
couple of calls of headroom above the 6-call cap, so the real backstop (a
genuinely runaway loop well past what the prompt asks for) still fires,
without punishing a run that did exactly what it was told.

```
Use the crm_get_phase2_candidates tool (contact_type: referral_partner) to pull 5 already-researched CPAs from the CRM. Using ONLY the information already returned for each of the 5 — do not search the web yet — pick the single most promising one as a referral-partner candidate: favor whoever looks strongest on audience fit and reach (years_in_business, client_count_est, review_rating/review_count, accepting_new_clients, any notes hinting at trade-client work). If several look similar, picking any reasonable one is fine, this is a coarse triage not a precise ranking. Then research ONLY that one contact — leave the other 4 completely untouched, they go back in the pool for a future run. Look specifically for: (1) whether the firm offers bookkeeping services itself — if so, they're a competitor, not a referral source, that's a hard disqualifier regardless of anything else; (2) whether the firm explicitly states it doesn't make referrals to other professionals — rare, but also a hard disqualifier if found; (3) whether the firm serves trade/contractor clients (HVAC, plumbing, electrical, construction) — check their site's services/"who we serve" page, case studies, testimonials; this is the strongest positive signal, actively look for it. Also try to fill in any gaps in years_in_business, client_count_est, review_rating/review_count, accepting_new_clients, or social_handles if phase 1 left them blank. Cap yourself at 6 web_search calls — you have more room here than phase 1 because you're going deeper on one already-verified entity instead of finding one from scratch, so use it to actually cover the distinct things listed above (website, in-house-bookkeeping check, no-referral check, trade-client evidence, reviews, gap-filling) rather than repeating variations of the same query. Each call should be going after a genuinely different piece of information — if you notice yourself rephrasing a query that already came up empty instead of moving to a different topic, that's your cue to stop searching and decide with what you have. Call crm_enrich_contact for ONLY your chosen contact_id: set status to 'potential' if no hard disqualifier was found and there's a real positive signal (especially trade-client evidence), or 'not_viable' if a hard disqualifier was found or there's simply no positive signal to justify pursuing them. Save offers_bookkeeping_inhouse, explicit_no_referral, and serves_trade_clients as true/false in signals, plus whatever else you found. Put your reasoning for the verdict in note — write it so a human can understand the call without re-deriving it. Then send me a short summary: which contact you picked and why, your verdict, and one line on why you passed on each of the other 4 based on what was already known about them.
```

## To backtrack

Copy the desired version's text into the `PROMPT_PHASE1=` (phase 1) or
`PROMPT_PHASE2=` (phase 2) assignment near the top of
`scripts/run-crm-batch.sh`, replacing the current one. Once this file itself
is committed, future edits to the live prompt will show up in `git log` /
`git diff` as normal — this manual history file only exists to cover the gap
before the first commit.

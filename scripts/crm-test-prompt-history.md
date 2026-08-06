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

### v4 — current (2026-08-06, this is what's live in run-crm-batch.sh's PROMPT_PHASE2)

Fixes a real runaway-loop finding from the third live single-run test (2026-08-06,
right after v3 shipped) — same underlying failure category already solved
once in phase 1 (see v5 above), recurring here because phase 2's prompt
never got the equivalent fix.

Picked **SIDRONY, LLC** ("Nabors and Sidrony, LLC") and burned **~15
`web_search` calls** — well past the stated 6-call cap — chasing
trade-client evidence. The firm's name collides with **Nabors Industries**
(an unrelated oil-drilling company) and the partner's first name "Nicole"
pulls generic Wikipedia/actress results; the model kept getting
plausible-looking-but-irrelevant hits and kept reformulating instead of
recognizing the collision. It only stopped because the last 3 queries
happened to come out byte-identical, tripping the watchdog's exact-match
detector (threshold 3, untouched by the phase-2 escalating/soft tuning) —
if each retry had varied even slightly it might not have been caught at
all, since the run's tool calls were interleaved with `web_fetch` often
enough that no single-tool streak ever got long enough to trip
`detectEscalatingRetry`/`detectSameToolStreak` (thresholds 8/9), and the
query texts didn't share a long enough common prefix to count as
"escalating" by that detector's own matching rule either. No data was
lost (contact 39309 was left untouched, still `researched`, will be
redrawn later) — just a lot of wasted time on one run.

v3's cap language ("cap yourself at 6... if a query already came up empty,
stop") didn't fire here because these queries weren't coming back
*empty* — they came back with real, confident-looking results about the
*wrong* entity, which reads differently to the model than "nothing found."
v4 ports the two pieces of phase 1's proven v5 fix that phase 2 was
missing: (1) the cap is now phrased as a hard countdown ("AT MOST 6...
count them as you go... the moment you've used all 6, stop") rather than
advisory; (2) explicit recognition of the name-collision trap specifically
— results being about an unrelated same-named entity, not just empty
results, is now called out as the stop signal.

```
Use the crm_get_phase2_candidates tool (contact_type: referral_partner) to pull 5 already-researched CPAs from the CRM. Using ONLY the information already returned for each of the 5 — do not search the web yet — pick the single most promising one as a referral-partner candidate: favor whoever looks strongest on audience fit and reach (years_in_business, client_count_est, review_rating/review_count, accepting_new_clients, any notes hinting at trade-client work). If several look similar, picking any reasonable one is fine, this is a coarse triage not a precise ranking. Then research ONLY that one contact — leave the other 4 completely untouched, they go back in the pool for a future run. Look specifically for: (1) whether the firm offers bookkeeping services itself — check the site's nav/services list for anything like "Bookkeeping Services"; if you see it, open that SPECIFIC page and read it, don't just infer from the label or move on. If the page describes them doing the bookkeeping work themselves (their own staff/process, no mention of outsourcing or referring it elsewhere), that's a hard disqualifier — they're a competitor, not a referral source. Only treat it as NOT disqualifying if the page explicitly says they outsource or refer bookkeeping to another firm/partner. If that specific page 404s or won't load but bookkeeping is still listed as one of their services elsewhere on the site (nav, homepage, service list), default to treating it as in-house and disqualify rather than leaving it unresolved — a firm advertising a service on its own site is offering it themselves unless stated otherwise; (2) whether the firm explicitly states it doesn't make referrals to other professionals — rare, but also a hard disqualifier if found; (3) whether the firm serves trade/contractor clients (HVAC, plumbing, electrical, construction) — check their site's services/"who we serve" page, case studies, testimonials; this is the strongest positive signal, actively look for it. Note: a firm NOT currently accepting new clients is NOT by itself a hard disqualifier — they can still be a great referral source, possibly even more motivated to refer people elsewhere since they can't take them on directly; only the two items in (1) and (2) above are hard disqualifiers. Also try to fill in any gaps in years_in_business, client_count_est, review_rating/review_count, accepting_new_clients, or social_handles if phase 1 left them blank. You get AT MOST 6 web_search calls total for this contact — count them as you go, and the moment you've used all 6, stop searching immediately and move to the verdict/save step with whatever you have, even if something's still unconfirmed. You have more room here than phase 1 because you're going deeper on one already-verified entity instead of finding one from scratch, so use it to actually cover the distinct things listed above (website, in-house-bookkeeping check, no-referral check, trade-client evidence, reviews, gap-filling) rather than repeating variations of the same query. Each call should be going after a genuinely different piece of information. Watch for a specific trap: a firm's name or the person's first name can collide with something totally unrelated (a large company with a similar name, a common first name pulling generic web results, a different business entirely) — if you notice your results are actually about that OTHER thing rather than the specific firm/person you're researching, that is your cue to stop searching and decide with what you have, not to keep rephrasing the query hoping the next one lands — plausible-looking results about the wrong entity are not progress. Call crm_enrich_contact for ONLY your chosen contact_id: set status to 'potential' if no hard disqualifier was found and there's a real positive signal (especially trade-client evidence), or 'not_viable' if a hard disqualifier was found or there's simply no positive signal to justify pursuing them. Save offers_bookkeeping_inhouse, explicit_no_referral, and serves_trade_clients as true/false in signals, plus whatever else you found. Put your reasoning for the verdict in note — write it so a human can understand the call without re-deriving it. YOU MUST ACTUALLY CALL crm_enrich_contact BEFORE REPLYING — a verdict written only in your reply to me is not saved anywhere in the CRM and will be lost; do not consider this task finished until that tool call has been made. Then send me a short summary: which contact you picked and why, your verdict, and one line on why you passed on each of the other 4 based on what was already known about them.
```

### v3 (2026-08-06, superseded by v4 above)

Two fixes from the second live single-run test (2026-08-05 night, right
after v2 shipped):

**Fix 1 — the model reasoned to a correct verdict, said out loud "I need
to update the CRM record," then never actually called
crm_enrich_contact.** Picked contact 3423 (Gary Brannon, CPA — the only
one of the 5 draws with real existing signals), fetched his site in one
web_fetch call, found "We are unable to take new clients at this time,"
wrote a clear NOT VIABLE verdict straight into its chat reply, and
stopped — zero calls to crm_enrich_contact, not even a malformed one.
DB-verified nothing changed (contact 3423 still `status='researched'`,
`updated_at` untouched from July 28, no note added). This is a more
serious failure mode than v1's evidence gap: it's silent data loss — no
error, no watchdog trigger, a normal-looking chat reply, but the write
never happened. `crm_enrich_contact`'s own "this is the ONLY thing that
gets saved" warning only helps once the model is mid-call; it can't catch
the tool never being invoked at all. Fixed with a hard-to-miss, explicit
line right where the tool-call instruction lives: "YOU MUST ACTUALLY CALL
crm_enrich_contact BEFORE REPLYING — a verdict written only in your reply
to me is not saved anywhere in the CRM and will be lost." User's own
framing after seeing this: hopefully a one-off, not something worth
over-engineering around if it doesn't recur — this fix is the appropriately-
sized response for now (a clearer instruction), not a new mechanical
enforcement layer.

**Fix 2 — "not accepting new clients" isn't a designed hard disqualifier,
but the model treated it like one.** Same run: having found the "unable to
take new clients" line, the model concluded NOT VIABLE on that basis
alone — but `accepting_new_clients` was only ever meant as one of several
inputs to the STEP-1 triage ranking (which of the 5 looks strongest), not
a verdict-stage disqualifier alongside `offers_bookkeeping_inhouse` /
`explicit_no_referral`. A CPA closed to new clients for their own practice
can still be, or even be more likely to be, a good referral source — they
have nowhere else to send people they can't take on. Added an explicit
note clarifying this isn't a hard disqualifier and only the two named
items are.

```
Use the crm_get_phase2_candidates tool (contact_type: referral_partner) to pull 5 already-researched CPAs from the CRM. Using ONLY the information already returned for each of the 5 — do not search the web yet — pick the single most promising one as a referral-partner candidate: favor whoever looks strongest on audience fit and reach (years_in_business, client_count_est, review_rating/review_count, accepting_new_clients, any notes hinting at trade-client work). If several look similar, picking any reasonable one is fine, this is a coarse triage not a precise ranking. Then research ONLY that one contact — leave the other 4 completely untouched, they go back in the pool for a future run. Look specifically for: (1) whether the firm offers bookkeeping services itself — check the site's nav/services list for anything like "Bookkeeping Services"; if you see it, open that SPECIFIC page and read it, don't just infer from the label or move on. If the page describes them doing the bookkeeping work themselves (their own staff/process, no mention of outsourcing or referring it elsewhere), that's a hard disqualifier — they're a competitor, not a referral source. Only treat it as NOT disqualifying if the page explicitly says they outsource or refer bookkeeping to another firm/partner. If that specific page 404s or won't load but bookkeeping is still listed as one of their services elsewhere on the site (nav, homepage, service list), default to treating it as in-house and disqualify rather than leaving it unresolved — a firm advertising a service on its own site is offering it themselves unless stated otherwise; (2) whether the firm explicitly states it doesn't make referrals to other professionals — rare, but also a hard disqualifier if found; (3) whether the firm serves trade/contractor clients (HVAC, plumbing, electrical, construction) — check their site's services/"who we serve" page, case studies, testimonials; this is the strongest positive signal, actively look for it. Note: a firm NOT currently accepting new clients is NOT by itself a hard disqualifier — they can still be a great referral source, possibly even more motivated to refer people elsewhere since they can't take them on directly; only the two items in (1) and (2) above are hard disqualifiers. Also try to fill in any gaps in years_in_business, client_count_est, review_rating/review_count, accepting_new_clients, or social_handles if phase 1 left them blank. Cap yourself at 6 web_search calls — you have more room here than phase 1 because you're going deeper on one already-verified entity instead of finding one from scratch, so use it to actually cover the distinct things listed above (website, in-house-bookkeeping check, no-referral check, trade-client evidence, reviews, gap-filling) rather than repeating variations of the same query. Each call should be going after a genuinely different piece of information — if you notice yourself rephrasing a query that already came up empty instead of moving to a different topic, that's your cue to stop searching and decide with what you have. Call crm_enrich_contact for ONLY your chosen contact_id: set status to 'potential' if no hard disqualifier was found and there's a real positive signal (especially trade-client evidence), or 'not_viable' if a hard disqualifier was found or there's simply no positive signal to justify pursuing them. Save offers_bookkeeping_inhouse, explicit_no_referral, and serves_trade_clients as true/false in signals, plus whatever else you found. Put your reasoning for the verdict in note — write it so a human can understand the call without re-deriving it. YOU MUST ACTUALLY CALL crm_enrich_contact BEFORE REPLYING — a verdict written only in your reply to me is not saved anywhere in the CRM and will be lost; do not consider this task finished until that tool call has been made. Then send me a short summary: which contact you picked and why, your verdict, and one line on why you passed on each of the other 4 based on what was already known about them.
```

### v2 (2026-08-05/06, superseded by v3 above)

Fixed a real gap found on phase 2's very first live run (single-run test,
2026-08-05 night): the model picked SPENCER TAX AND ACCOUNTING, LLC,
correctly found "Bookkeeping Services" listed in the firm's own site nav
on the first page fetch (also captured "bookkeeping" as the first entry in
its own saved `signals.specialties`), then went looking for an explicit
"in-house" label instead of treating "the firm lists this as one of their
own services" as sufficient evidence — hit two 404s on guessed sub-page
URLs, gave up, and verdicted `potential` with `offers_bookkeeping_inhouse`
left unset and a note reading "unclear if in-house or for referral
partnerships." User checked the live site directly afterward: it's
unambiguous, they do it in-house, don't outsource/refer it. Confirms this
was a real evidence-interpretation gap, not a coincidental hunch.

v1's instruction ("whether the firm offers bookkeeping services itself —
if so... hard disqualifier") stated the RULE correctly but never told the
model what counts as sufficient evidence or what to do when the specific
page it goes looking for isn't the one that actually has the answer. v2
adds three concrete pieces the model was missing: (1) actually open and
read the specific bookkeeping-services page once you see it in the
nav/services list, don't just infer from the label; (2) only treat it as
NOT disqualifying if that page explicitly says they outsource/refer
bookkeeping elsewhere — silence isn't evidence of outsourcing; (3) if the
specific page 404s (as it did live) but bookkeeping is still listed
elsewhere on the site, default to in-house/disqualify rather than leaving
it unresolved, since a firm advertising a service on its own site is
offering it themselves unless stated otherwise.

```
Use the crm_get_phase2_candidates tool (contact_type: referral_partner) to pull 5 already-researched CPAs from the CRM. Using ONLY the information already returned for each of the 5 — do not search the web yet — pick the single most promising one as a referral-partner candidate: favor whoever looks strongest on audience fit and reach (years_in_business, client_count_est, review_rating/review_count, accepting_new_clients, any notes hinting at trade-client work). If several look similar, picking any reasonable one is fine, this is a coarse triage not a precise ranking. Then research ONLY that one contact — leave the other 4 completely untouched, they go back in the pool for a future run. Look specifically for: (1) whether the firm offers bookkeeping services itself — check the site's nav/services list for anything like "Bookkeeping Services"; if you see it, open that SPECIFIC page and read it, don't just infer from the label or move on. If the page describes them doing the bookkeeping work themselves (their own staff/process, no mention of outsourcing or referring it elsewhere), that's a hard disqualifier — they're a competitor, not a referral source. Only treat it as NOT disqualifying if the page explicitly says they outsource or refer bookkeeping to another firm/partner. If that specific page 404s or won't load but bookkeeping is still listed as one of their services elsewhere on the site (nav, homepage, service list), default to treating it as in-house and disqualify rather than leaving it unresolved — a firm advertising a service on its own site is offering it themselves unless stated otherwise; (2) whether the firm explicitly states it doesn't make referrals to other professionals — rare, but also a hard disqualifier if found; (3) whether the firm serves trade/contractor clients (HVAC, plumbing, electrical, construction) — check their site's services/"who we serve" page, case studies, testimonials; this is the strongest positive signal, actively look for it. Also try to fill in any gaps in years_in_business, client_count_est, review_rating/review_count, accepting_new_clients, or social_handles if phase 1 left them blank. Cap yourself at 6 web_search calls — you have more room here than phase 1 because you're going deeper on one already-verified entity instead of finding one from scratch, so use it to actually cover the distinct things listed above (website, in-house-bookkeeping check, no-referral check, trade-client evidence, reviews, gap-filling) rather than repeating variations of the same query. Each call should be going after a genuinely different piece of information — if you notice yourself rephrasing a query that already came up empty instead of moving to a different topic, that's your cue to stop searching and decide with what you have. Call crm_enrich_contact for ONLY your chosen contact_id: set status to 'potential' if no hard disqualifier was found and there's a real positive signal (especially trade-client evidence), or 'not_viable' if a hard disqualifier was found or there's simply no positive signal to justify pursuing them. Save offers_bookkeeping_inhouse, explicit_no_referral, and serves_trade_clients as true/false in signals, plus whatever else you found. Put your reasoning for the verdict in note — write it so a human can understand the call without re-deriving it. Then send me a short summary: which contact you picked and why, your verdict, and one line on why you passed on each of the other 4 based on what was already known about them.
```

### v1 (2026-08-05, superseded by v2 above)

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

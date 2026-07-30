# CRM enrichment test prompt — version history

`scripts/run-crm-batch.sh` has never been committed until 2026-07-28, so git
history doesn't have earlier versions of the embedded prompt — kept here
instead so we can backtrack if a future change makes results worse, not
better.

## v4 — current (2026-07-29, this is what's live in run-crm-batch.sh)

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

## To backtrack

Copy the desired version's text into the `PROMPT=` assignment near the top of
`scripts/run-crm-batch.sh`, replacing the current one. Once this file itself
is committed, future edits to the live prompt will show up in `git log` /
`git diff` as normal — this manual history file only exists to cover the gap
before the first commit.

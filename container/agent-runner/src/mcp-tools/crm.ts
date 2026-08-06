/**
 * crm_get_next_prospect / crm_enrich_contact / crm_get_phase2_candidates —
 * the enrichment steps of the lead-gen pipeline (see the leadgen-crm
 * project). The CRM is a standalone Next.js app with its own local SQLite
 * database, running (for now, dev only) as `npm run dev` outside this
 * container — reached over HTTP, not a shared file mount, matching this
 * codebase's "one writer per DB" rule.
 *
 * Two pipeline stages share crm_enrich_contact as their single write path:
 * phase 1 (crm_get_next_prospect -> research -> enrich, status
 * 'researched') finds basic contact info at volume; phase 2
 * (crm_get_phase2_candidates -> research -> enrich, status 'potential' /
 * 'not_viable') does a deeper pass over already-researched contacts to
 * decide who's actually worth pursuing. There is no delete/remove tool
 * here on purpose — if a run produces bad data, a human cleans it up in
 * the dashboard; the agent should never be able to remove a row.
 * crm_enrich_contact also never overwrites `signals` wholesale — the CRM
 * API merges it server-side (json_patch), so a bad or partial enrichment
 * pass can't destroy a previous good one.
 *
 * Base URL: NanoClaw containers reach the host via `host.docker.internal`
 * for Windows-native processes (LM Studio, OneCLI), but the CRM's dev
 * server runs inside this same WSL2 distro, which `host.docker.internal`
 * does NOT route back to (confirmed: Docker Desktop's gateway does not
 * proxy into this distro's own network namespace). The distro's own eth0
 * IP is directly reachable from containers instead — that's the default
 * below. This IP can change on a WSL2 restart; override with
 * LEADGEN_CRM_BASE_URL if it stops connecting.
 */
import { setResearchPhase } from './research-budget.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const CRM_BASE_URL = process.env.LEADGEN_CRM_BASE_URL || 'http://172.27.29.246:3000';
const REQUEST_TIMEOUT_MS = 10_000;

async function crmFetch(
  path: string,
  init?: RequestInit,
): Promise<{ data: unknown } | { error: string }> {
  let res: Response;
  try {
    res = await fetch(`${CRM_BASE_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return {
      error: `Could not reach the CRM at ${CRM_BASE_URL} (${e instanceof Error ? e.message : String(e)}). It may not be running — do not guess or invent contact data to fill the gap; report that enrichment is unavailable right now.`,
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { error: `CRM returned HTTP ${res.status}: ${body.slice(0, 500)}` };
  }
  return { data: await res.json() };
}

export const crmGetNextProspect: McpToolDefinition = {
  tool: {
    name: 'crm_get_next_prospect',
    description:
      "Get one prospect from the lead-gen CRM that hasn't been researched yet (status 'new'). Returns their name, address, license info, and any existing signals — this is real, already-verified contact data, not something to guess at. Use web_search/web_fetch to research this specific person/firm by name and location, then call crm_enrich_contact with what you find. If it returns no contact, the queue is empty — say so, don't invent one. Use `max_years_licensed` if your instructions specify a threshold — over 40,000 contacts are in the CRM and most aren't worth enriching yet, so narrowing by recency-of-license is how the pool gets prioritized instead of picking a purely random contact.\n\nDon't bother fetching people-search/background-check sites (Whitepages, Radaris, Spokeo, ContactOut, BeenVerified, TruePeopleSearch, Intelius, MyLife, and similar) even if they show up in search results — web_fetch refuses these domains outright, and even if it didn't, what they show non-subscribers is paywalled placeholder data, not real contact info (confirmed: a real fetch of a Spokeo page returned a phone number with letters in it and a nonsense email — garbage, not a real person's real info, just formatted to look plausible at a glance). Time spent on these is time not spent finding an actual source.\n\nIF THE NAME YOU FIND DOESN'T MATCH: a web search will sometimes turn up someone with a different surname in the same city/practice area (e.g. CRM says \"Peters\", search turns up a \"Trickey\" at a firm in the same town) — do NOT assume these are the same person just because the first name, city, or general practice area line up. Verify using the `license_number` this tool already gave you: look it up at the relevant state's official license/board lookup (Florida's is myfloridalicense.com/LicenseDetail.asp?id=<license_number> — confirmed working) and check what primary name that license currently shows. A real name change (marriage, etc.) will show up there under the SAME license number — that's a confirmed match, go ahead and use the new name. If you can't confirm it that way, don't assert they're the same person: either skip the mismatched info or save it with confidence \"low\" and a note explicitly flagging the unverified name mismatch, so a human knows to check it rather than assuming it's solid.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        contact_type: {
          type: 'string',
          enum: ['referral_partner', 'business_owner'],
          description: 'Restrict to this contact_type. Omit for either.',
        },
        contact_subtype: {
          type: 'string',
          description: "Restrict to this subtype, e.g. 'cpa_individual', 'cpa_firm'. Omit for any.",
        },
        max_years_licensed: {
          type: 'integer',
          description:
            'Only return a prospect licensed this many years or fewer. Newer licensees are the current priority — check the system prompt / your instructions for the current threshold rather than guessing one.',
        },
      },
    },
  },
  async handler(args) {
    setResearchPhase('phase1');

    const params = new URLSearchParams();
    if (args.contact_type) params.set('contact_type', String(args.contact_type));
    if (args.contact_subtype) params.set('contact_subtype', String(args.contact_subtype));
    if (args.max_years_licensed !== undefined) params.set('max_years_licensed', String(args.max_years_licensed));

    const result = await crmFetch(`/api/contacts/next?${params.toString()}`);
    if ('error' in result) return err(result.error);

    const data = result.data as { contact: unknown; message?: string };
    if (!data.contact) return ok(data.message ?? 'No uncontacted prospects left.');

    log(`crm_get_next_prospect -> id ${(data.contact as { id: number }).id}`);
    return ok(JSON.stringify(data.contact, null, 2));
  },
};

export const crmEnrichContact: McpToolDefinition = {
  tool: {
    name: 'crm_enrich_contact',
    description:
      "Save research findings for a contact from the CRM (get their id from crm_get_next_prospect first). IMPORTANT: this tool call is the ONLY thing that gets saved — your chat reply to the user is not stored anywhere in the CRM. Before you write your final summary to the user, ask yourself \"did I actually put everything I'm about to tell them into this call?\" — if you found something noteworthy (e.g. \"not accepting new clients right now\", \"license shows inactive\", \"firm appears to have closed\"), it MUST go in `signals` or `note` here, not just in your reply. Only include fields you actually found — this call is additive: `signals` is merged into whatever's already there (never wiped), and omitted fields are left untouched. If you couldn't find something, just leave it out rather than filling it with a guess. There is NO delete tool — you cannot remove a contact, only add to what's known about them. Use `note` for anything that reads better as a sentence — context, caveats, or a finding that doesn't fit a clean key/value.\n\nPRIORITIZE THESE SPECIFIC `signals` KEYS over general prose — they get pulled into their own filterable dashboard columns server-side (a human will filter/sort on them directly), and this data is what a later, separate enrichment pass will use to decide who's actually worth pursuing, so completeness on these matters more than exhaustive freeform notes: `years_in_business` (int), `firm_founded` (the actual founding year, not a duration — save both this and years_in_business if you know the founding year, they're not redundant since years_in_business would otherwise go stale), `accepting_new_clients` (true/false), `review_count` (int), `review_rating` (number), `client_count_est` (int), `social_handles` (object, e.g. `{\"linkedin\": \"https://...\"}`), and `practice_role` — one of \"solo\" (sole practitioner), \"owner\" (owns/founded the firm), \"partner\" (partner at a firm, has real authority), \"employee\" (works for someone else, no say in referral relationships — e.g. an audit manager at a large firm, in-house counsel), or \"unknown\". `practice_role` matters a lot here: someone employed by a large firm with zero autonomy (confirmed real examples: a PwC audit manager, in-house counsel at a hospital system) is not a usable referral-partner lead even though they're a real, correctly-researched person — always try to determine and save this. (See crm_get_next_prospect's description for what to do when the name you find doesn't match the CRM record.)\n\nPHASE 2 ONLY — if you arrived here via crm_get_phase2_candidates (not crm_get_next_prospect), also save `offers_bookkeeping_inhouse`, `explicit_no_referral`, and `serves_trade_clients` (all true/false) in `signals`, and set `status` to `potential` or `not_viable` per that tool's instructions rather than `researched`. Exception: if you hit your web_search/web_fetch budget cap and genuinely need more research before you can decide, save `needs_more_research: true` in `signals` instead and leave `status` as `researched` — the server accepts `researched` in this one case since it's not a final verdict, and a future phase-2 run will prioritize this contact.\n\nRATE YOUR CONFIDENCE. For every field you save (email/phone/website, and each key in `signals`), also add an entry in `confidence` (\"low\"/\"medium\"/\"high\") and, where you can, `sources` (the URL or site name it came from) using the SAME field name as the key. For email/phone/website specifically: if the source you cite is a low-quality/people-search site (Whitepages, Radaris, ContactOut, Spokeo, BeenVerified, TruePeopleSearch, Intelius, MyLife, and similar background-check/people-finder sites), the VALUE gets discarded server-side, not just downgraded — these sites show paywalled placeholder data to non-subscribers, not real contact info, so there's nothing worth keeping even at low confidence. Don't assert a firm/employer association from one of these at all unless the person's actual name appears on that firm's own page. This matters most for the fields that determine who you'd actually contact or claim they work with — email, phone, firm/employer association — hold those to a real standard (an official site, a licensing board, a direct listing) before rating them medium/high. Softer signals (review sentiment, social media presence, general reputation) can honestly be lower confidence — that's expected, not a problem, just say so.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        contact_id: { type: 'integer', description: 'The id from crm_get_next_prospect' },
        email: { type: 'string' },
        phone: { type: 'string' },
        website: { type: 'string' },
        status: {
          type: 'string',
          enum: [
            'new',
            'researched',
            'contacted',
            'responded',
            'partner',
            'client',
            'not_interested',
            'do_not_contact',
            'bounced',
            'potential',
            'not_viable',
          ],
        },
        signals: {
          type: 'object',
          description: 'Freeform key/value findings — merged into existing signals, not replaced.',
        },
        confidence: {
          type: 'object',
          description:
            'Per-field confidence, keyed by field name (e.g. {"phone": "low", "years_in_business": "high"}). Values must be "low", "medium", or "high".',
        },
        sources: {
          type: 'object',
          description:
            'Per-field source, same keys as confidence (e.g. {"phone": "https://www.whitepages.com/..."}) — a URL if you have one, otherwise just the site/method name.',
        },
        note: {
          type: 'string',
          description: 'Optional freeform note — what you found and where, in your own words.',
        },
      },
      required: ['contact_id'],
    },
  },
  async handler(args) {
    const { contact_id, ...body } = args;
    if (typeof contact_id !== 'number') return err('contact_id (integer) is required');

    const result = await crmFetch(`/api/contacts/${contact_id}/enrich`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if ('error' in result) return err(result.error);

    const data = result.data as { contact: unknown; fieldsChanged?: boolean; noteAdded?: boolean };

    // fieldsChanged=false means none of email/phone/website/status/signals
    // actually landed on a column — e.g. a malformed call that lost a field
    // (confirmed real case, contact 11384, 2026-08-05: a local model's
    // `status` parameter leaked as literal text into `note` instead of
    // becoming its own field). Without this check the response looks
    // identical to a real save, so the model has no way to notice and retry.
    if (data.fieldsChanged === false) {
      log(`crm_enrich_contact -> id ${contact_id} call had no effect (note only: ${data.noteAdded})`);
      return ok(
        data.noteAdded
          ? `Note added, but NO other fields were changed — status/email/phone/website/signals were not present in this call (or were rejected). If you intended to set any of those, call crm_enrich_contact again for contact ${contact_id} with them included as top-level fields, not folded into the note text.`
          : `Nothing was saved — this call had no effect (no note, and no status/email/phone/website/signals present). Re-check the call and try again for contact ${contact_id} if you have findings to record.`,
      );
    }

    log(`crm_enrich_contact -> id ${contact_id} updated`);
    return ok(`Saved. Current record:\n${JSON.stringify(data.contact, null, 2)}`);
  },
};

export const crmGetPhase2Candidates: McpToolDefinition = {
  tool: {
    name: 'crm_get_phase2_candidates',
    description:
      "Phase 2 of the enrichment pipeline: a deeper research pass over contacts phase 1 already marked 'researched', to decide who's actually worth pursuing as a referral partner. Returns up to `count` (default 5) random already-researched contacts, each with everything phase 1 already found (practice_role, years_in_business, client_count_est, review_rating/review_count, accepting_new_clients, social_handles, notes, etc.) — this call does NOT do any new research itself.\n\nSTEP 1 — pick ONE of the returned candidates using ONLY what's already here, before doing any web searches: favor whoever looks strongest on audience fit and reach (years_in_business, client_count_est, review_rating/review_count, accepting_new_clients, any notes hinting at trade-client work). This is a coarse triage, not a precise ranking — if several look similarly promising, picking any reasonable one is fine.\n\nSTEP 2 — research ONLY your chosen candidate. Do NOT research or touch the other candidates at all; leave them exactly as they are, they go back in the pool for a future run. Look specifically for:\n- Does the firm offer bookkeeping services itself? Check the site's nav/services list for anything like \"Bookkeeping Services\" — if you see it, open that SPECIFIC page and read it, don't just infer from the label or move on. If it describes them doing the bookkeeping work themselves (their own staff/process, no mention of outsourcing or referring it elsewhere), that's a HARD DISQUALIFIER — they are a competitor, not a referral source. Only treat this as NOT disqualifying if the page explicitly says they outsource or refer bookkeeping to another firm/partner. If that specific page 404s or won't load but bookkeeping is still listed as one of their services elsewhere on the site, default to treating it as in-house and disqualify rather than leaving it unresolved — a firm advertising a service on its own site is offering it themselves unless stated otherwise.\n- Does the firm explicitly state it doesn't make referrals to other professionals? Rare, but also a HARD DISQUALIFIER if found.\n- Does the firm serve trade/contractor clients (HVAC, plumbing, electrical, construction)? Check their site's services/'who we serve' page, case studies, testimonials, industries-served lists. This is the single strongest POSITIVE indicator — actively look for it, don't just note its absence.\n- A firm NOT currently accepting new clients is NOT by itself a hard disqualifier — they can still be a great referral source, possibly even more motivated to refer people elsewhere since they can't take them on directly. Only the two items above are hard disqualifiers.\n- Also try to fill in any gaps phase 1 left in years_in_business, client_count_est, review_rating/review_count, accepting_new_clients, or social_handles.\nYou get AT MOST 6 web_search calls AND AT MOST 6 web_fetch calls total for this contact — count them as you go. These caps are enforced mechanically, not just by this instruction: the moment you go over either one, that tool returns a budget-exceeded message instead of actually performing the call, so don't wait to self-regulate — stop searching/fetching as soon as you hit 6 of either and move to the verdict/save step with whatever you have, even if something's still unconfirmed. More room than phase 1 since you're going deeper on one already-verified entity rather than finding one from scratch, so use the budget to actually cover the distinct topics above (website, in-house-bookkeeping check, no-referral check, trade-client evidence, reviews, gap-filling), not to repeat variations of the same query. Watch for a specific trap: a firm's name or the person's first name can collide with something totally unrelated (a large company with a similar name, a common first name pulling generic web results, a different business entirely) — if your results are actually about that OTHER thing rather than the specific firm/person you're researching, that is your cue to stop searching and decide with what you have, not to keep rephrasing the query hoping the next one lands. Plausible-looking results about the wrong entity are not progress.\n\nIf you hit a budget cap and genuinely believe more research would change the verdict — don't guess. Call crm_enrich_contact with `signals.needs_more_research: true` and status left at `researched` (not a final verdict) instead of forcing `potential`/`not_viable` on incomplete information. A future phase-2 run will pick this contact back up first (before any fresh random draw) with its own full search/fetch budget, so nothing you've already found is wasted.\n\nSTEP 3 — call crm_enrich_contact for ONLY the chosen contact_id (see that tool's PHASE 2 ONLY section): set status to `potential` if no hard disqualifier was found and there's a real positive signal (especially trade-client evidence), or `not_viable` if a hard disqualifier was found, or if there's simply no positive signal to justify pursuing them. Save `offers_bookkeeping_inhouse` / `explicit_no_referral` / `serves_trade_clients` as booleans in `signals`, plus whatever else you found. Put your reasoning for the verdict in `note` — write it so a human can understand the call without re-deriving it. YOU MUST ACTUALLY CALL crm_enrich_contact BEFORE REPLYING TO THE USER — reaching a verdict in your own reasoning is not the same as saving it; a verdict written only in your reply is not stored anywhere in the CRM and will be lost. Do not consider this task finished until that tool call has been made, even if the verdict was obvious or found quickly.\n\nAny contact listed in this response's `auto_disqualified` array was already resolved to `not_viable` server-side before you ever saw it (a known employee or a firm phase 1 already found inactive) — that's informational only, nothing for you to act on.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        contact_type: {
          type: 'string',
          enum: ['referral_partner', 'business_owner'],
          description:
            'Restrict candidates to this contact_type. Omit for either — in practice only referral_partner has researched data right now.',
        },
        count: {
          type: 'integer',
          description: 'How many candidates to draw (default 5).',
        },
      },
    },
  },
  async handler(args) {
    setResearchPhase('phase2');

    const params = new URLSearchParams();
    if (args.contact_type) params.set('contact_type', String(args.contact_type));
    if (args.count !== undefined) params.set('count', String(args.count));

    const result = await crmFetch(`/api/contacts/phase2-candidates?${params.toString()}`);
    if ('error' in result) return err(result.error);

    const data = result.data as { candidates: unknown[]; auto_disqualified: unknown[] };
    if (!data.candidates || data.candidates.length === 0) {
      return ok(
        'No researched contacts available for phase 2 right now — the pool may be exhausted, or everything currently eligible has already been auto-disqualified. Say so, do not invent a candidate.',
      );
    }

    log(
      `crm_get_phase2_candidates -> ${data.candidates.length} candidates, ${data.auto_disqualified?.length ?? 0} auto-disqualified this call`,
    );
    return ok(JSON.stringify(data, null, 2));
  },
};

registerTools([crmGetNextProspect, crmEnrichContact, crmGetPhase2Candidates]);

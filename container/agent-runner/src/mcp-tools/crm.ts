/**
 * crm_get_next_prospect / crm_enrich_contact — the enrichment step of the
 * lead-gen pipeline (see the leadgen-crm project). The CRM is a standalone
 * Next.js app with its own local SQLite database, running (for now, dev
 * only) as `npm run dev` outside this container — reached over HTTP, not a
 * shared file mount, matching this codebase's "one writer per DB" rule.
 *
 * Deliberately two tools, not one generic CRUD tool: pick-a-prospect and
 * write-findings are the only two operations this pipeline stage needs.
 * There is no delete/remove tool here on purpose — if a run produces bad
 * data, a human cleans it up in the dashboard; the agent should never be
 * able to remove a row. crm_enrich_contact also never overwrites `signals`
 * wholesale — the CRM API merges it server-side (json_patch), so a bad or
 * partial enrichment pass can't destroy a previous good one.
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
      "Get one prospect from the lead-gen CRM that hasn't been researched yet (status 'new'). Returns their name, address, license info, and any existing signals — this is real, already-verified contact data, not something to guess at. Use web_search/web_fetch (or delegate_web_research) to research this specific person/firm by name and location, then call crm_enrich_contact with what you find. If it returns no contact, the queue is empty — say so, don't invent one.",
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
      },
    },
  },
  async handler(args) {
    const params = new URLSearchParams();
    if (args.contact_type) params.set('contact_type', String(args.contact_type));
    if (args.contact_subtype) params.set('contact_subtype', String(args.contact_subtype));

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
      "Save research findings for a contact from the CRM (get their id from crm_get_next_prospect first). IMPORTANT: this tool call is the ONLY thing that gets saved — your chat reply to the user is not stored anywhere in the CRM. Before you write your final summary to the user, ask yourself \"did I actually put everything I'm about to tell them into this call?\" — if you found something noteworthy (e.g. \"not accepting new clients right now\", \"license shows inactive\", \"firm appears to have closed\"), it MUST go in `signals` or `note` here, not just in your reply. Only include fields you actually found — this call is additive: `signals` is merged into whatever's already there (never wiped), and omitted fields are left untouched. If you couldn't find something, just leave it out rather than filling it with a guess. There is NO delete tool — you cannot remove a contact, only add to what's known about them. Use `signals` for short factual key/value findings (years_in_business, client_count_est, review_rating, review_count, social_handles as an object, accepting_new_clients as true/false). Use `note` for anything that reads better as a sentence — context, caveats, or a finding that doesn't fit a clean key/value.\n\nRATE YOUR CONFIDENCE. For every field you save (email/phone/website, and each key in `signals`), also add an entry in `confidence` (\"low\"/\"medium\"/\"high\") and, where you can, `sources` (the URL or site name it came from) using the SAME field name as the key. A low-quality/people-search source (Whitepages, Radaris, ContactOut, Spokeo, BeenVerified, TruePeopleSearch, Intelius, MyLife, and similar background-check/people-finder sites) gets automatically forced to \"low\" confidence server-side no matter what you claim — those sites are scraped, often stale, and easy to mismatch to the wrong person (especially for a common name), so don't bother claiming high confidence from one, and don't assert a firm/employer association from one at all unless the person's actual name appears on that firm's own page. This matters most for the fields that determine who you'd actually contact or claim they work with — email, phone, firm/employer association — hold those to a real standard (an official site, a licensing board, a direct listing) before rating them medium/high. Softer signals (review sentiment, social media presence, general reputation) can honestly be lower confidence — that's expected, not a problem, just say so.",
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

    const data = result.data as { contact: unknown };
    log(`crm_enrich_contact -> id ${contact_id} updated`);
    return ok(`Saved. Current record:\n${JSON.stringify(data.contact, null, 2)}`);
  },
};

registerTools([crmGetNextProspect, crmEnrichContact]);

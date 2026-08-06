/**
 * web_search / web_fetch — purpose-built local tools instead of leaning on
 * agent-browser (real page interaction) or a hosted search API (OpenCode's
 * native `websearch` requires OPENCODE_ENABLE_EXA=true and calls out to
 * Exa's cloud service — a departure from the local-only setup). Both tools
 * here run entirely inside the container: fetch + parse, no third-party
 * cloud search backend, full control over sanitization and error handling.
 *
 * web_search queries a self-hosted SearXNG instance (see `searxng/` at repo
 * root) rather than scraping DuckDuckGo's HTML results page directly, which
 * this originally did. Under sustained batch volume (a 100-run overnight
 * CRM enrichment batch, 2026-07-30) DDG started blocking/rate-limiting the
 * large majority of requests — confirmed via the per-run tool-call
 * trajectory logs, not an assumption. SearXNG fans one query out to several
 * no-API-key engines (DuckDuckGo, Brave, Startpage, Mojeek, Qwant, Bing,
 * Yahoo) in parallel and merges the results, so one engine blocking no
 * longer sinks search entirely — each engine has its own independent rate
 * limit. But a follow-up batch the same day (2026-07-31) showed EVERY
 * configured engine accumulating blocks under enough same-day volume, not
 * just DuckDuckGo — engine diversity alone has a ceiling. SearXNG stays
 * primary (free, usually enough) and is tried on every single call, never
 * permanently given up on within a run; once it's missed
 * SEARXNG_FAILURE_THRESHOLD times in a row, that specific call ALSO tries
 * Serper (paid, google.serper.dev) as a rescue, but the very next call
 * tries SearXNG again fresh — see the const block below for why per-turn
 * beats a sticky trip-for-the-rest-of-the-run latch (an earlier version
 * did that and overpaid for Serper once SearXNG had already recovered).
 * web_fetch retrieves a specific URL and returns cleaned readable text plus
 * regex-extracted emails/phone numbers, since that's the exact shape the
 * lead-gen use case needs (contact info off a firm's site) and a small
 * local model doing that extraction itself by eye is slower and less
 * reliable than deterministic regex. web_fetch is unaffected by the DDG
 * issue — it's a direct fetch of a URL search already returned, not a
 * search itself.
 */
import { lookup as dnsLookup } from 'dns/promises';

import * as cheerio from 'cheerio';

import { checkWebFetchBudget, checkWebSearchBudget } from './research-budget.js';
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

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5_000_000; // 5MB cap — plenty for a directory/profile page, guards a runaway download
const MAX_REDIRECTS = 10;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Same reachability pattern as the CRM tool (crm.ts): the SearXNG container
// runs on this same WSL2 distro's own network namespace, which
// host.docker.internal does not route back into — the distro's own eth0 IP
// is directly reachable from containers instead. That IP can change on a
// WSL2 restart; override with SEARXNG_BASE_URL if it stops connecting.
const SEARXNG_BASE_URL = process.env.SEARXNG_BASE_URL || 'http://172.27.29.246:8080';

// Serper.dev — paid Google-results API, fallback only (SearXNG is primary;
// see the 2026-07-31 project memory for why: it's free and usually enough).
// Auth is transparent: OneCLI's egress proxy injects the X-API-KEY header
// for requests to this host once a vault secret with a matching
// --host-pattern exists (see docs/onecli-gateway skill) — this file never
// sees or handles the real key. Until that secret is created, every Serper
// call below fails closed (401/whatever the gateway lets through) and
// performWebSearch degrades to exactly its pre-Serper behavior.
const SERPER_URL = 'https://google.serper.dev/search';

// "fails a few times" (user's framing) → SearXNG is tried on EVERY call, no
// exceptions — it never gets permanently given up on within a run. A
// rolling counter of consecutive misses (empty results or unreachable)
// decides, per call, whether to ALSO try Serper as a rescue once that
// count reaches the threshold. The moment SearXNG succeeds again the
// counter resets and Serper stops being called — no separate "recovery"
// step needed, since SearXNG was never skipped in the first place.
// Deliberately per-turn, not a sticky trip-for-the-rest-of-the-run latch:
// an earlier version latched permanently once tripped, but that meant one
// bad patch of 3 misses would keep paying for Serper for a run's remaining
// searches even if SearXNG recovered on the very next call. Always
// re-probing costs one extra (usually fast, ~1-2s) SearXNG request per
// miss while degraded, which is worth it to never overpay once healthy
// again. Plain in-memory module counter, not persisted across runs: the
// agent-runner process is per-run (one CRM enrichment run per container —
// see run-bakeoff-test.sh), so it naturally starts fresh every run anyway.
const SEARXNG_FAILURE_THRESHOLD = 3;
let searxngConsecutiveFailures = 0;

// Distinct from the SearXNG counter above and NOT per-turn on purpose: a
// missing/invalid vault secret (HTTP 403, confirmed live) is a static
// config fact for this run, unlike SearXNG's blocks which can clear
// mid-run — so once we see it, there's nothing to gain by paying the
// latency of re-probing Serper on every subsequent miss in this run too.
// Still re-checked fresh on the next run (new process, new container).
let serperKnownUnconfigured = false;

/** Test-only: this module's state is otherwise process-lifetime, which would leak between test cases. */
export function __resetSearxngBreakerForTests(): void {
  searxngConsecutiveFailures = 0;
  serperKnownUnconfigured = false;
}

// --- Manual redirect handling with a cookie jar ------------------------
// Browser fetch() has an implicit cookie jar (the browser owns one);
// server-side fetch() (Bun, Node, Deno) does not — each request is
// stateless unless the caller re-attaches cookies itself. Some sites
// (confirmed: irs.treasury.gov/rpo/rpo.jsf) mint a fresh session cookie on
// every hop and only stop redirecting once they see the SAME cookie come
// back, which a plain `fetch()` with default redirect:'follow' can never
// satisfy — it loops until hitting the runtime's internal redirect cap and
// fails with "redirected too many times". Handling redirects manually here
// also closes a latent SSRF gap: `redirect: 'follow'` would otherwise
// follow a redirect to an internal address without re-checking it.

export function parseCookiePair(setCookieHeader: string): [string, string] | null {
  const semi = setCookieHeader.indexOf(';');
  const pair = semi >= 0 ? setCookieHeader.slice(0, semi) : setCookieHeader;
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  return [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()];
}

export function cookieHeaderFrom(cookies: Map<string, string>): string {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Extracts Set-Cookie values from a Response, however the runtime exposes them. */
function extractSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === 'function') return getSetCookie.call(headers);
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

export async function fetchFollowingRedirects(
  startUrl: URL,
  timeoutMs: number,
  // Injectable for tests: a real local test server necessarily runs on
  // loopback, which assertPublicUrl (correctly) always blocks — so a test
  // exercising the redirect/cookie mechanics needs a permissive stub here,
  // while a separate test verifies the real SSRF re-validation deliberately
  // by passing the default. Production call sites never pass this.
  validateHop: (url: string) => Promise<{ error: string } | { url: URL }> = assertPublicUrl,
): Promise<{ error: string } | { res: Response; finalUrl: URL }> {
  let currentUrl = startUrl;
  const cookies = new Map<string, string>();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const cookieHeader = cookieHeaderFrom(cookies);
    let res: Response;
    try {
      res = await fetch(currentUrl, {
        headers: { 'User-Agent': USER_AGENT, ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { error: `Fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    for (const setCookie of extractSetCookies(res.headers)) {
      const pair = parseCookiePair(setCookie);
      if (pair) cookies.set(pair[0], pair[1]);
    }

    const isRedirect = res.status >= 300 && res.status < 400;
    const location = res.headers.get('location');
    if (!isRedirect || !location) {
      return { res, finalUrl: currentUrl };
    }

    const nextUrl = new URL(location, currentUrl);
    const check = await validateHop(nextUrl.href);
    if ('error' in check) return { error: `Redirect blocked: ${check.error}` };
    currentUrl = check.url;
  }
  return { error: `Too many redirects (>${MAX_REDIRECTS})` };
}

// --- SSRF guard -------------------------------------------------------
// Blocks the obvious internal-network targets a scraped page could try to
// redirect the agent toward (host.docker.internal is how this container
// reaches LM Studio AND the OneCLI gateway — a prompt-injected page telling
// the agent to "fetch" an internal URL must not be able to reach either).
// This is a practical guard against accidental/injected SSRF, not a
// hardened defense against a determined DNS-rebinding attacker: the
// hostname is checked and its DNS-resolved address is checked once
// up front, but fetch() re-resolves internally and could theoretically
// land on a different address for a TTL=0 attacker-controlled domain.

const BLOCKED_HOSTNAMES = new Set(['localhost', 'host.docker.internal', '0.0.0.0']);

export function isPrivateOrLoopbackIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local (cloud metadata lives here)
  if (a === 0) return true;
  return false;
}

export function isPrivateOrLoopbackIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
}

// --- Low-quality research source guard ----------------------------------
// Distinct from the SSRF guard above (that's about network safety; this is
// about data quality) — people-search/background-check aggregators show
// paywalled, masked placeholder data to non-subscribers, not real facts.
// Confirmed live: a fetch of a Spokeo profile page returned a phone number
// with letters in it ("(908) 839-NBNR") and a nonsense email, both
// formatted to look plausible at a glance. An agent has no way to tell
// that's fake from the page content alone, so it's blocked at the fetch
// layer instead of left to a downstream consumer to distrust — this way no
// agent group can be fooled by this class of page, regardless of task.
// Keep this in sync with leadgen-crm's lib/low-quality-sources.ts
// (a separate repo/codebase, so duplicated rather than shared) — grow both
// as new ones show up in practice.
const LOW_QUALITY_RESEARCH_HOSTNAMES = [
  'whitepages.com',
  'radaris.com',
  'contactout.com',
  'spokeo.com',
  'beenverified.com',
  'truepeoplesearch.com',
  'fastpeoplesearch.com',
  'peoplefinders.com',
  'intelius.com',
  'mylife.com',
  'checkpeople.com',
  'familytreenow.com',
  'thatsthem.com',
  'peekyou.com',
  'usphonebook.com',
  'zabasearch.com',
  'nuwber.com',
  'cyberbackgroundchecks.com',
  'instantcheckmate.com',
  'truthfinder.com',
  'peoplelooker.com',
  'searchpeoplefree.com',
  'voterrecords.com',
];

export function isLowQualityResearchHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return LOW_QUALITY_RESEARCH_HOSTNAMES.some((marker) => lower === marker || lower.endsWith(`.${marker}`));
}

// --- LinkedIn personal-profile guard -------------------------------------
// Distinct from the low-quality-host list above — LinkedIn itself is a good
// source, but a bare/unauthenticated fetch of a /in/ personal-profile page
// almost always hits its anti-bot wall: either a login-gated stub ("Sign in
// to view X's full profile") or an outright HTTP 999. Confirmed live across
// many enrichment runs — every /in/ fetch attempted has hit one of the two.
// Company pages (/company/...) are NOT walled the same way and have
// returned real About/website/employee data live, so only /in/ is blocked
// here — the search-result snippet for a profile URL usually already
// surfaces the useful bio text without needing the page itself.
function isLinkedInProfilePath(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  if (hostname !== 'linkedin.com' && !hostname.endsWith('.linkedin.com')) return false;
  return url.pathname.startsWith('/in/');
}

async function assertFetchableUrl(rawUrl: string): Promise<{ error: string } | { url: URL }> {
  const publicCheck = await assertPublicUrl(rawUrl);
  if ('error' in publicCheck) return publicCheck;
  if (isLowQualityResearchHost(publicCheck.url.hostname)) {
    return {
      error: `Refusing to fetch ${publicCheck.url.hostname} — this is a paywalled people-search/background-check aggregator. What it shows non-subscribers is masked placeholder data (fake-looking phone numbers and emails), not real facts about anyone. Find a different source instead of retrying this one.`,
    };
  }
  if (isLinkedInProfilePath(publicCheck.url)) {
    return {
      error:
        'Refusing to fetch a LinkedIn personal-profile URL (/in/...) — an unauthenticated fetch always hits a login wall or an anti-bot block, never real content. Use the snippet text web_search already returned for this URL instead (it usually has the useful bio/title/company info); do not retry this fetch. LinkedIn company pages (linkedin.com/company/...) are not blocked and are fine to fetch.',
    };
  }
  return publicCheck;
}

export async function assertPublicUrl(rawUrl: string): Promise<{ error: string } | { url: URL }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: `Not a valid URL: ${rawUrl}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `Unsupported URL scheme "${url.protocol}" — only http/https allowed` };
  }
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.internal')) {
    return { error: `Refusing to fetch internal/blocked host: ${hostname}` };
  }
  if (isPrivateOrLoopbackIPv4(hostname) || isPrivateOrLoopbackIPv6(hostname)) {
    return { error: `Refusing to fetch private/loopback address: ${hostname}` };
  }
  try {
    const resolved = await dnsLookup(hostname);
    if (isPrivateOrLoopbackIPv4(resolved.address) || isPrivateOrLoopbackIPv6(resolved.address)) {
      return { error: `Refusing to fetch ${hostname} — resolves to a private/loopback address` };
    }
  } catch {
    return { error: `Could not resolve host: ${hostname}` };
  }
  return { url };
}

// --- SearXNG result parsing ---------------------------------------------
// SearXNG's /search?format=json returns { results: [{ title, url, content,
// engines, score, ... }, ...] } — already-structured JSON, no HTML scraping
// needed (unlike the old direct-DDG approach this replaced). Parsing is
// deliberately defensive about shape since it's a third-party response body.

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function parseSearxngResults(body: unknown, maxResults: number): SearchResult[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];

  const out: SearchResult[] = [];
  for (const r of results) {
    if (out.length >= maxResults) break;
    const entry = r as { title?: unknown; url?: unknown; content?: unknown };
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    const snippet = typeof entry.content === 'string' ? entry.content.trim() : '';
    if (!title || !url) continue;
    out.push({ title, url, snippet });
  }
  return out;
}

// --- Serper result parsing -----------------------------------------------
// Serper's POST /search returns { organic: [{ title, link, snippet, ... }],
// ... } — same defensive-shape approach as parseSearxngResults since it's
// also a third-party response body.

export function parseSerperResults(body: unknown, maxResults: number): SearchResult[] {
  const results = (body as { organic?: unknown } | null)?.organic;
  if (!Array.isArray(results)) return [];

  const out: SearchResult[] = [];
  for (const r of results) {
    if (out.length >= maxResults) break;
    const entry = r as { title?: unknown; link?: unknown; snippet?: unknown };
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    const url = typeof entry.link === 'string' ? entry.link.trim() : '';
    const snippet = typeof entry.snippet === 'string' ? entry.snippet.trim() : '';
    if (!title || !url) continue;
    out.push({ title, url, snippet });
  }
  return out;
}

// --- Readable text + contact extraction --------------------------------

export function htmlToReadableText(html: string, maxChars: number): string {
  const $ = cheerio.load(html);
  $('script, style, nav, footer, noscript, svg').remove();
  const text = $('body').text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated at ${maxChars} chars]` : text;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// US-style phone numbers: (555) 123-4567, 555-123-4567, 555.123.4567, +1 555 123 4567
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

export function extractContacts(text: string): { emails: string[]; phones: string[] } {
  const emails = [...new Set(text.match(EMAIL_RE) ?? [])];
  const phones = [...new Set(text.match(PHONE_RE) ?? [])];
  return { emails, phones };
}

// --- Core logic, reusable outside the MCP layer -------------------------
// Factored out so the (future) sub-agent's internal tool loop can call the
// exact same search/fetch behavior in-process, without round-tripping
// through the MCP protocol a second time for what's really the same tool.

function formatSearchResults(results: SearchResult[]): string {
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
}

// baseUrl/url params default to the module consts and only exist as a test
// seam (same idiom as fetchFollowingRedirects's validateHop param below) —
// production call sites never pass them.

export async function trySearxng(
  query: string,
  maxResults: number,
  baseUrl: string = SEARXNG_BASE_URL,
): Promise<{ results: SearchResult[] } | { error: string }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return { error: `could not reach SearXNG at ${baseUrl} (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!res.ok) return { error: `SearXNG returned HTTP ${res.status}` };
  const body = await res.json().catch(() => null);
  return { results: parseSearxngResults(body, maxResults) };
}

// No auth header set here on purpose — the OneCLI gateway injects X-API-KEY
// for requests to this host once a vault secret exists (see the const's
// comment above). Until then this comes back 403 (confirmed live against
// the real endpoint with no key and with a garbage key — Serper uses 403
// for both missing and invalid credentials, not 401) and performWebSearch
// falls through to reporting search as unavailable, same as if Serper were
// never wired.
export async function trySerper(
  query: string,
  maxResults: number,
  url: string = SERPER_URL,
): Promise<{ results: SearchResult[] } | { error: string; unconfigured?: boolean }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: maxResults }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return { error: `could not reach Serper (${e instanceof Error ? e.message : String(e)})` };
  }
  if (res.status === 403) return { error: 'Serper returned HTTP 403 (no vault secret configured yet)', unconfigured: true };
  if (!res.ok) return { error: `Serper returned HTTP ${res.status}` };
  const body = await res.json().catch(() => null);
  return { results: parseSerperResults(body, maxResults) };
}

export async function performWebSearch(
  query: string,
  maxResults: number,
  opts: { searxngBaseUrl?: string; serperUrl?: string } = {},
): Promise<{ text: string } | { error: string }> {
  const trimmed = query?.trim();
  if (!trimmed) return { error: 'query is required' };

  const budgetMsg = checkWebSearchBudget();
  if (budgetMsg) return { text: budgetMsg };

  const capped = Math.min(Math.max(maxResults || 5, 1), 15);

  const searxng = await trySearxng(trimmed, capped, opts.searxngBaseUrl);
  if ('results' in searxng && searxng.results.length > 0) {
    searxngConsecutiveFailures = 0;
    log(`web_search (searxng): "${trimmed}" -> ${searxng.results.length} result(s)`);
    return { text: formatSearchResults(searxng.results) };
  }

  searxngConsecutiveFailures++;
  const reason = 'error' in searxng ? searxng.error : 'zero results';
  log(`web_search: SearXNG miss ${searxngConsecutiveFailures} in a row (${reason})`);
  if (searxngConsecutiveFailures < SEARXNG_FAILURE_THRESHOLD) {
    return { text: 'No results for this query — try rephrasing or broadening it.' };
  }

  if (serperKnownUnconfigured) {
    log(`web_search: SearXNG has missed ${searxngConsecutiveFailures} times in a row — skipping Serper (already confirmed unconfigured this run)`);
    return {
      error:
        'Both SearXNG and the Serper fallback are unavailable right now. Do not fall back to guessing — report that search is unavailable.',
    };
  }

  log(`web_search: SearXNG has missed ${searxngConsecutiveFailures} times in a row — trying the Serper fallback for this search (will try SearXNG again on the next one)`);
  const serper = await trySerper(trimmed, capped, opts.serperUrl);
  if ('error' in serper) {
    if (serper.unconfigured) serperKnownUnconfigured = true;
    log(`web_search: Serper fallback also failed (${serper.error})`);
    return {
      error:
        'Both SearXNG and the Serper fallback are unavailable right now. Do not fall back to guessing — report that search is unavailable.',
    };
  }
  log(`web_search (serper fallback): "${trimmed}" -> ${serper.results.length} result(s)`);
  if (serper.results.length === 0) {
    return { text: 'No results for this query — try rephrasing or broadening it.' };
  }
  return { text: formatSearchResults(serper.results) };
}

export async function performWebFetch(rawUrl: string, maxChars: number): Promise<{ text: string } | { error: string }> {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return { error: 'url is required' };

  const budgetMsg = checkWebFetchBudget();
  if (budgetMsg) return { text: budgetMsg };

  const capped = Math.min(Math.max(maxChars || 5000, 500), 20_000);

  const check = await assertFetchableUrl(trimmed);
  if ('error' in check) return { error: check.error };

  const fetched = await fetchFollowingRedirects(check.url, FETCH_TIMEOUT_MS, assertFetchableUrl);
  if ('error' in fetched) return { error: fetched.error };
  const { res } = fetched;
  if (!res.ok) return { error: `Fetch returned HTTP ${res.status}` };

  const contentLength = Number(res.headers.get('content-length') ?? '0');
  if (contentLength > MAX_RESPONSE_BYTES) {
    return { error: `Page too large (${contentLength} bytes > ${MAX_RESPONSE_BYTES} cap)` };
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('html') && !contentType.includes('text')) {
    return { error: `Unsupported content-type: ${contentType || 'unknown'}` };
  }

  const html = await res.text();
  if (html.length > MAX_RESPONSE_BYTES) {
    return { error: `Page too large (${html.length} bytes > ${MAX_RESPONSE_BYTES} cap)` };
  }
  const text = htmlToReadableText(html, capped);
  const { emails, phones } = extractContacts(text);

  log(`web_fetch: ${fetched.finalUrl.href} -> ${text.length} chars, ${emails.length} email(s), ${phones.length} phone(s)`);

  const parts = [text];
  if (emails.length > 0) parts.push(`\n[emails found: ${emails.join(', ')}]`);
  if (phones.length > 0) parts.push(`\n[phone numbers found: ${phones.join(', ')}]`);
  return { text: parts.join('\n') };
}

// --- Tools ---------------------------------------------------------------

export const webSearch: McpToolDefinition = {
  tool: {
    name: 'web_search',
    description:
      'Search the web and return titles, URLs, and snippets. Use to find pages worth fetching with web_fetch — this tool does not read full page content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { type: 'integer', description: 'Max results to return (default 5, max 15)' },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    const result = await performWebSearch(args.query as string, Number(args.maxResults));
    return 'error' in result ? err(result.error) : ok(result.text);
  },
};

export const webFetch: McpToolDefinition = {
  tool: {
    name: 'web_fetch',
    description:
      'Fetch a specific URL and return its readable text plus any email addresses and phone numbers found on the page. Use after web_search to read a page it returned. Cannot execute JavaScript — for pages that require it, fall back to agent-browser. Refuses linkedin.com/in/... personal-profile URLs outright (they always hit a login wall) — use the web_search snippet for those instead; linkedin.com/company/... pages are not blocked.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to fetch (http/https only)' },
        maxChars: { type: 'integer', description: 'Max characters of text to return (default 5000)' },
      },
      required: ['url'],
    },
  },
  async handler(args) {
    const result = await performWebFetch(args.url as string, Number(args.maxChars));
    return 'error' in result ? err(result.error) : ok(result.text);
  },
};

registerTools([webSearch, webFetch]);

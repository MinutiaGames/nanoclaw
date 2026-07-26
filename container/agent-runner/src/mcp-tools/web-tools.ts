/**
 * web_search / web_fetch — purpose-built local tools instead of leaning on
 * agent-browser (real page interaction) or a hosted search API (OpenCode's
 * native `websearch` requires OPENCODE_ENABLE_EXA=true and calls out to
 * Exa's cloud service — a departure from the local-only setup). Both tools
 * here run entirely inside the container: fetch + parse, no third-party
 * search backend, full control over sanitization and error handling.
 *
 * web_search scrapes DuckDuckGo's non-JS HTML results page (no API key,
 * stable-ish markup). web_fetch retrieves a specific URL and returns
 * cleaned readable text plus regex-extracted emails/phone numbers, since
 * that's the exact shape the lead-gen use case needs (contact info off a
 * firm's site) and a small local model doing that extraction itself by eye
 * is slower and less reliable than deterministic regex.
 */
import { lookup as dnsLookup } from 'dns/promises';

import * as cheerio from 'cheerio';

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

// --- DuckDuckGo HTML result parsing ------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Unwrap DDG's `//duckduckgo.com/l/?uddg=<encoded-real-url>` redirect wrapper. */
function unwrapDdgRedirect(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const real = u.searchParams.get('uddg');
    return real ? decodeURIComponent(real) : href;
  } catch {
    return href;
  }
}

export function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  $('.result').each((_, el) => {
    if (results.length >= maxResults) return;
    const titleEl = $(el).find('.result__a').first();
    const title = titleEl.text().trim().replace(/\s+/g, ' ');
    const href = titleEl.attr('href');
    const snippet = $(el).find('.result__snippet').first().text().trim().replace(/\s+/g, ' ');
    if (!title || !href) return;
    results.push({ title, url: unwrapDdgRedirect(href), snippet });
  });
  return results;
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

// --- Tools ---------------------------------------------------------------

export const webSearch: McpToolDefinition = {
  tool: {
    name: 'web_search',
    description:
      'Search the web (DuckDuckGo) and return titles, URLs, and snippets. Use to find pages worth fetching with web_fetch — this tool does not read full page content.',
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
    const query = (args.query as string)?.trim();
    if (!query) return err('query is required');
    const maxResults = Math.min(Math.max(Number(args.maxResults) || 5, 1), 15);

    let res: Response;
    try {
      res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      return err(`Search request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) return err(`Search returned HTTP ${res.status}`);

    const html = await res.text();
    const results = parseDuckDuckGoResults(html, maxResults);
    log(`web_search: "${query}" -> ${results.length} result(s)`);
    if (results.length === 0) {
      return ok('No results (or DuckDuckGo blocked/rate-limited this request — try again or rephrase the query).');
    }
    return ok(results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n'));
  },
};

export const webFetch: McpToolDefinition = {
  tool: {
    name: 'web_fetch',
    description:
      'Fetch a specific URL and return its readable text plus any email addresses and phone numbers found on the page. Use after web_search to read a page it returned. Cannot execute JavaScript — for pages that require it, fall back to agent-browser.',
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
    const rawUrl = (args.url as string)?.trim();
    if (!rawUrl) return err('url is required');
    const maxChars = Math.min(Math.max(Number(args.maxChars) || 5000, 500), 20_000);

    const check = await assertPublicUrl(rawUrl);
    if ('error' in check) return err(check.error);

    const fetched = await fetchFollowingRedirects(check.url, FETCH_TIMEOUT_MS);
    if ('error' in fetched) return err(fetched.error);
    const { res } = fetched;
    if (!res.ok) return err(`Fetch returned HTTP ${res.status}`);

    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (contentLength > MAX_RESPONSE_BYTES) {
      return err(`Page too large (${contentLength} bytes > ${MAX_RESPONSE_BYTES} cap)`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return err(`Unsupported content-type: ${contentType || 'unknown'}`);
    }

    const html = await res.text();
    if (html.length > MAX_RESPONSE_BYTES) {
      return err(`Page too large (${html.length} bytes > ${MAX_RESPONSE_BYTES} cap)`);
    }
    const text = htmlToReadableText(html, maxChars);
    const { emails, phones } = extractContacts(text);

    log(`web_fetch: ${fetched.finalUrl.href} -> ${text.length} chars, ${emails.length} email(s), ${phones.length} phone(s)`);

    const parts = [text];
    if (emails.length > 0) parts.push(`\n[emails found: ${emails.join(', ')}]`);
    if (phones.length > 0) parts.push(`\n[phone numbers found: ${phones.join(', ')}]`);
    return ok(parts.join('\n'));
  },
};

registerTools([webSearch, webFetch]);

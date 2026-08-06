import { afterEach, describe, expect, test } from 'bun:test';

import { __resetResearchBudgetForTests, setResearchPhase } from './research-budget.js';
import {
  __resetSearxngBreakerForTests,
  assertPublicUrl,
  cookieHeaderFrom,
  extractContacts,
  fetchFollowingRedirects,
  htmlToReadableText,
  isPrivateOrLoopbackIPv4,
  isPrivateOrLoopbackIPv6,
  parseCookiePair,
  parseSearxngResults,
  parseSerperResults,
  performWebFetch,
  performWebSearch,
} from './web-tools.js';

describe('parseSearxngResults', () => {
  const SAMPLE_RESPONSE = {
    query: 'jane doe cpa',
    results: [
      {
        title: 'Jane Doe CPA & Associates',
        url: 'https://example.com/jane-doe-cpa',
        content: 'Certified public accountant serving the metro area. Call today.',
        engines: ['duckduckgo', 'brave'],
      },
      {
        title: 'Smith Tax & Bookkeeping',
        url: 'https://example.org/smith-tax',
        content: 'Full-service tax prep.',
        engines: ['mojeek'],
      },
    ],
  };

  test('extracts title, url, and snippet', () => {
    const results = parseSearxngResults(SAMPLE_RESPONSE, 5);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Jane Doe CPA & Associates');
    expect(results[0].url).toBe('https://example.com/jane-doe-cpa');
    expect(results[0].snippet).toContain('Certified public accountant');
  });

  test('respects maxResults', () => {
    expect(parseSearxngResults(SAMPLE_RESPONSE, 1)).toHaveLength(1);
  });

  test('skips entries missing a title or url', () => {
    const results = parseSearxngResults(
      { results: [{ title: '', url: 'https://example.com', content: 'x' }, { title: 'No URL', content: 'x' }] },
      5,
    );
    expect(results).toHaveLength(0);
  });

  test('non-array/missing results returns no results', () => {
    expect(parseSearxngResults({}, 5)).toHaveLength(0);
    expect(parseSearxngResults(null, 5)).toHaveLength(0);
    expect(parseSearxngResults({ results: 'nope' }, 5)).toHaveLength(0);
  });
});

describe('parseSerperResults', () => {
  const SAMPLE_RESPONSE = {
    searchParameters: { q: 'jane doe cpa' },
    organic: [
      { title: 'Jane Doe CPA & Associates', link: 'https://example.com/jane-doe-cpa', snippet: 'Certified public accountant.', position: 1 },
      { title: 'Smith Tax & Bookkeeping', link: 'https://example.org/smith-tax', snippet: 'Full-service tax prep.', position: 2 },
    ],
  };

  test('extracts title, url (from "link"), and snippet', () => {
    const results = parseSerperResults(SAMPLE_RESPONSE, 5);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Jane Doe CPA & Associates');
    expect(results[0].url).toBe('https://example.com/jane-doe-cpa');
    expect(results[0].snippet).toBe('Certified public accountant.');
  });

  test('respects maxResults', () => {
    expect(parseSerperResults(SAMPLE_RESPONSE, 1)).toHaveLength(1);
  });

  test('skips entries missing a title or link', () => {
    const results = parseSerperResults(
      { organic: [{ title: '', link: 'https://example.com', snippet: 'x' }, { title: 'No link', snippet: 'x' }] },
      5,
    );
    expect(results).toHaveLength(0);
  });

  test('non-array/missing organic returns no results', () => {
    expect(parseSerperResults({}, 5)).toHaveLength(0);
    expect(parseSerperResults(null, 5)).toHaveLength(0);
    expect(parseSerperResults({ organic: 'nope' }, 5)).toHaveLength(0);
  });
});

describe('performWebSearch — SearXNG-primary / Serper-fallback, per-turn', () => {
  let searxngServer: ReturnType<typeof Bun.serve> | null = null;
  let serperServer: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    searxngServer?.stop(true);
    serperServer?.stop(true);
    searxngServer = null;
    serperServer = null;
    __resetSearxngBreakerForTests();
  });

  /** A fake SearXNG that returns `results` on every call and counts how many times it was hit. */
  function startFakeSearxng(results: Array<{ title: string; url: string; content: string }>): { url: string; hits: () => number } {
    let hitCount = 0;
    searxngServer = Bun.serve({
      port: 0,
      fetch() {
        hitCount++;
        return Response.json({ results });
      },
    });
    return { url: `http://localhost:${searxngServer.port}`, hits: () => hitCount };
  }

  function startFakeSerper(organic: Array<{ title: string; link: string; snippet: string }>): { url: string; hits: () => number } {
    let hitCount = 0;
    serperServer = Bun.serve({
      port: 0,
      fetch() {
        hitCount++;
        return Response.json({ organic });
      },
    });
    return { url: `http://localhost:${serperServer.port}`, hits: () => hitCount };
  }

  test('returns SearXNG results directly when it has results — never calls Serper', async () => {
    const searxng = startFakeSearxng([{ title: 'Real Firm', url: 'https://example.com', content: 'A real CPA firm.' }]);
    const result = await performWebSearch('jane doe cpa', 5, { searxngBaseUrl: searxng.url, serperUrl: 'http://127.0.0.1:1' });
    expect('text' in result && result.text).toContain('Real Firm');
    expect(searxng.hits()).toBe(1);
  });

  test('two SearXNG misses (below threshold 3) never call Serper', async () => {
    const searxng = startFakeSearxng([]); // always empty
    await performWebSearch('q1', 5, { searxngBaseUrl: searxng.url, serperUrl: 'http://127.0.0.1:1' });
    const second = await performWebSearch('q2', 5, { searxngBaseUrl: searxng.url, serperUrl: 'http://127.0.0.1:1' });
    expect('text' in second && second.text).toContain('No results');
    expect(searxng.hits()).toBe(2);
  });

  test('third consecutive SearXNG miss ALSO tries Serper as a rescue for that call', async () => {
    const searxng = startFakeSearxng([]); // always empty -> 3 misses
    const serper = startFakeSerper([{ title: 'From Serper', link: 'https://example.com/serper', snippet: 'Found via fallback.' }]);
    await performWebSearch('q1', 5, { searxngBaseUrl: searxng.url, serperUrl: serper.url });
    await performWebSearch('q2', 5, { searxngBaseUrl: searxng.url, serperUrl: serper.url });
    const third = await performWebSearch('q3', 5, { searxngBaseUrl: searxng.url, serperUrl: serper.url });
    expect('text' in third && third.text).toContain('From Serper');
    expect(searxng.hits()).toBe(3);
    expect(serper.hits()).toBe(1);
  });

  test('per-turn, not sticky: the very next call after a Serper rescue tries SearXNG again, and uses it if it succeeds', async () => {
    const searxng = startFakeSearxng([]); // starts always-empty
    const serper = startFakeSerper([{ title: 'From Serper', link: 'https://example.com/serper', snippet: 'x' }]);
    for (let i = 0; i < 3; i++) await performWebSearch(`q${i}`, 5, { searxngBaseUrl: searxng.url, serperUrl: serper.url });
    expect(searxng.hits()).toBe(3);
    expect(serper.hits()).toBe(1);

    // SearXNG "recovers" for the 4th call — performWebSearch must still be
    // trying it (not skipping straight to Serper because of the earlier miss streak).
    searxngServer?.stop(true);
    const recovered = startFakeSearxng([{ title: 'Recovered', url: 'https://x.com', content: 'x' }]);
    const fourth = await performWebSearch('q4', 5, { searxngBaseUrl: recovered.url, serperUrl: serper.url });
    expect('text' in fourth && fourth.text).toContain('Recovered');
    expect(recovered.hits()).toBe(1); // SearXNG WAS tried on this call
    expect(serper.hits()).toBe(1); // unchanged — Serper wasn't needed once SearXNG succeeded
  });

  test('a SearXNG success resets the miss counter, so a later streak needs its own 3 misses', async () => {
    let call = 0;
    searxngServer = Bun.serve({
      port: 0,
      fetch() {
        call++;
        // miss, miss, HIT, miss, miss, miss -> reaches the threshold only on
        // the 6th call (3 fresh misses after the reset), not the 5th (2+3).
        return call === 3 ? Response.json({ results: [{ title: 'Recovered', url: 'https://x.com', content: 'x' }] }) : Response.json({ results: [] });
      },
    });
    const searxngUrl = `http://localhost:${searxngServer.port}`;
    const serper = startFakeSerper([{ title: 'From Serper', link: 'https://example.com/serper', snippet: 'x' }]);

    await performWebSearch('q1', 5, { searxngBaseUrl: searxngUrl, serperUrl: serper.url }); // miss 1
    await performWebSearch('q2', 5, { searxngBaseUrl: searxngUrl, serperUrl: serper.url }); // miss 2
    const third = await performWebSearch('q3', 5, { searxngBaseUrl: searxngUrl, serperUrl: serper.url }); // hit -> reset
    expect('text' in third && third.text).toContain('Recovered');

    await performWebSearch('q4', 5, { searxngBaseUrl: searxngUrl, serperUrl: serper.url }); // miss 1 (post-reset)
    await performWebSearch('q5', 5, { searxngBaseUrl: searxngUrl, serperUrl: serper.url }); // miss 2 (post-reset)
    expect(serper.hits()).toBe(0); // threshold not reached yet — only 2 misses since the reset
    const sixth = await performWebSearch('q6', 5, { searxngBaseUrl: searxngUrl, serperUrl: serper.url }); // miss 3 -> reaches threshold
    expect('text' in sixth && sixth.text).toContain('From Serper');
    expect(serper.hits()).toBe(1);
  });

  test('threshold reached + Serper also fails -> returns an error, not a misleading "no results"', async () => {
    const searxng = startFakeSearxng([]);
    for (let i = 0; i < 3; i++) {
      await performWebSearch(`q${i}`, 5, { searxngBaseUrl: searxng.url, serperUrl: 'http://127.0.0.1:1' });
    }
    const result = await performWebSearch('q4', 5, { searxngBaseUrl: searxng.url, serperUrl: 'http://127.0.0.1:1' });
    expect('error' in result).toBe(true);
  });

  test('threshold reached + Serper reachable but genuinely empty -> "no results", not an error', async () => {
    const searxng = startFakeSearxng([]);
    const serper = startFakeSerper([]);
    for (let i = 0; i < 3; i++) {
      await performWebSearch(`q${i}`, 5, { searxngBaseUrl: searxng.url, serperUrl: serper.url });
    }
    const result = await performWebSearch('q4', 5, { searxngBaseUrl: searxng.url, serperUrl: serper.url });
    expect('text' in result && result.text).toContain('No results');
  });

  test('a 403 from Serper (no vault secret yet) is remembered — later misses in the same run skip calling it', async () => {
    const searxng = startFakeSearxng([]); // always empty
    let serperHits = 0;
    serperServer = Bun.serve({ port: 0, fetch: () => (serperHits++, new Response('forbidden', { status: 403 })) });
    const serperUrl = `http://localhost:${serperServer.port}`;

    for (let i = 0; i < 3; i++) await performWebSearch(`q${i}`, 5, { searxngBaseUrl: searxng.url, serperUrl }); // reaches threshold -> 1 Serper call, sees 403
    expect(serperHits).toBe(1);

    // Two more misses in the same run — Serper should NOT be called again.
    await performWebSearch('q4', 5, { searxngBaseUrl: searxng.url, serperUrl });
    const result = await performWebSearch('q5', 5, { searxngBaseUrl: searxng.url, serperUrl });
    expect(serperHits).toBe(1); // unchanged
    expect('error' in result).toBe(true); // still reports unavailable, just without the wasted request
  });
});

describe('performWebSearch / performWebFetch — mechanical phase-2 budget', () => {
  let searxngServer: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    searxngServer?.stop(true);
    searxngServer = null;
    __resetSearxngBreakerForTests();
    __resetResearchBudgetForTests();
  });

  function startFakeSearxng(): { url: string; hits: () => number } {
    let hitCount = 0;
    searxngServer = Bun.serve({
      port: 0,
      fetch() {
        hitCount++;
        return Response.json({ results: [{ title: 'Real Firm', url: 'https://example.com', content: 'x' }] });
      },
    });
    return { url: `http://localhost:${searxngServer.port}`, hits: () => hitCount };
  }

  test('phase1 (no cap set): 20 web_search calls all reach SearXNG for real', async () => {
    setResearchPhase('phase1');
    const searxng = startFakeSearxng();
    for (let i = 0; i < 20; i++) {
      await performWebSearch(`q${i}`, 5, { searxngBaseUrl: searxng.url });
    }
    expect(searxng.hits()).toBe(20);
  });

  test('phase2: the 7th web_search call is blocked before ever reaching SearXNG', async () => {
    setResearchPhase('phase2');
    const searxng = startFakeSearxng();
    for (let i = 0; i < 6; i++) {
      const r = await performWebSearch(`q${i}`, 5, { searxngBaseUrl: searxng.url });
      expect('text' in r && r.text).toContain('Real Firm');
    }
    expect(searxng.hits()).toBe(6);

    const seventh = await performWebSearch('q7', 5, { searxngBaseUrl: searxng.url });
    expect('text' in seventh && seventh.text).toContain('budget exceeded');
    expect('text' in seventh && seventh.text).toContain('needs_more_research');
    expect(searxng.hits()).toBe(6); // unchanged — the 7th call never reached the network
  });

  test('phase2: the 7th web_fetch call is blocked before ever reaching URL validation, independently of web_search', async () => {
    setResearchPhase('phase2');
    // Exhaust the search budget — must not affect the fetch budget.
    const searxng = startFakeSearxng();
    for (let i = 0; i < 6; i++) await performWebSearch(`q${i}`, 5, { searxngBaseUrl: searxng.url });

    // A syntactically invalid URL fails synchronously in assertPublicUrl (no
    // network involved) — proves the budget check let these 6 calls through
    // to real validation, without needing a live network in the test env.
    for (let i = 0; i < 6; i++) {
      const r = await performWebFetch('not a valid url', 5000);
      expect('error' in r && r.error).toBe('Not a valid URL: not a valid url');
    }
    const seventh = await performWebFetch('not a valid url', 5000);
    expect('text' in seventh && seventh.text).toContain('web_fetch budget exceeded');
  });
});

describe('htmlToReadableText', () => {
  test('strips script/style/nav/footer and collapses whitespace', () => {
    const html = `
      <html><body>
        <nav>Home | About</nav>
        <script>trackUser();</script>
        <style>.x { color: red }</style>
        <main>
          <h1>Jane Doe, CPA</h1>
          <p>Phone:   (555) 123-4567</p>
        </main>
        <footer>Copyright 2026</footer>
      </body></html>
    `;
    const text = htmlToReadableText(html, 5000);
    expect(text).toContain('Jane Doe, CPA');
    expect(text).toContain('(555) 123-4567');
    expect(text).not.toContain('trackUser');
    expect(text).not.toContain('Home | About');
    expect(text).not.toContain('Copyright 2026');
  });

  test('truncates at maxChars', () => {
    const html = `<body>${'a'.repeat(10_000)}</body>`;
    const text = htmlToReadableText(html, 100);
    expect(text.length).toBeLessThan(150);
    expect(text).toContain('[truncated at 100 chars]');
  });
});

describe('extractContacts', () => {
  test('finds emails and US phone numbers in mixed formats', () => {
    const text = `
      Contact Jane Doe CPA at jane@example.com or call (555) 123-4567.
      Alt line: 555.987.6543 / info@smithtax.org / +1 555-222-3333
    `;
    const { emails, phones } = extractContacts(text);
    expect(emails).toContain('jane@example.com');
    expect(emails).toContain('info@smithtax.org');
    expect(phones).toContain('(555) 123-4567');
    expect(phones.some((p) => p.includes('987') && p.includes('6543'))).toBe(true);
  });

  test('dedupes repeated matches', () => {
    const { emails } = extractContacts('a@b.com a@b.com a@b.com');
    expect(emails).toEqual(['a@b.com']);
  });

  test('no matches returns empty arrays', () => {
    expect(extractContacts('nothing to see here')).toEqual({ emails: [], phones: [] });
  });
});

describe('isPrivateOrLoopbackIPv4 / IPv6', () => {
  test('flags loopback, private, and link-local ranges', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1']) {
      expect(isPrivateOrLoopbackIPv4(ip)).toBe(true);
    }
  });

  test('does not flag public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1']) {
      expect(isPrivateOrLoopbackIPv4(ip)).toBe(false);
    }
  });

  test('flags loopback and link-local IPv6', () => {
    expect(isPrivateOrLoopbackIPv6('::1')).toBe(true);
    expect(isPrivateOrLoopbackIPv6('fe80::1')).toBe(true);
    expect(isPrivateOrLoopbackIPv6('fc00::1')).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  test('rejects non-http(s) schemes', async () => {
    const result = await assertPublicUrl('ftp://example.com/file');
    expect('error' in result).toBe(true);
  });

  test('rejects malformed URLs', async () => {
    const result = await assertPublicUrl('not a url');
    expect('error' in result).toBe(true);
  });

  test('rejects host.docker.internal (LM Studio / OneCLI gateway)', async () => {
    const result = await assertPublicUrl('http://host.docker.internal:10254/api/agents');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('blocked host');
  });

  test('rejects localhost and *.localhost', async () => {
    expect('error' in (await assertPublicUrl('http://localhost/'))).toBe(true);
    expect('error' in (await assertPublicUrl('http://foo.localhost/'))).toBe(true);
  });

  test('rejects private/loopback IP literals without needing DNS', async () => {
    expect('error' in (await assertPublicUrl('http://127.0.0.1:8080/'))).toBe(true);
    expect('error' in (await assertPublicUrl('http://192.168.1.1/'))).toBe(true);
    expect('error' in (await assertPublicUrl('http://169.254.169.254/latest/meta-data'))).toBe(true);
  });

  // Needs real DNS resolution — example.com is IANA-reserved for exactly
  // this kind of stable documentation/testing use.
  test('allows a real public domain', async () => {
    const result = await assertPublicUrl('https://example.com/page');
    expect('url' in result).toBe(true);
  });
});

describe('performWebFetch — LinkedIn personal-profile guard', () => {
  test('refuses linkedin.com/in/... without making a network request', async () => {
    const result = await performWebFetch('https://www.linkedin.com/in/jane-doe-cpa-12345', 5000);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('login wall');
      expect(result.error).toContain('company');
    }
  });

  test('does not refuse linkedin.com/company/...', async () => {
    // No live network access in the test sandbox, so this exercises the
    // guard check only (it should NOT return the /in/ refusal message) —
    // whatever happens past that point is a real fetch attempt, which will
    // itself fail offline, but with a different error than the guard's.
    const result = await performWebFetch('https://www.linkedin.com/company/example', 5000);
    if ('error' in result) {
      expect(result.error).not.toContain('login wall');
    }
  });

  test('bare linkedin.com root is not blocked by the /in/ guard', async () => {
    const result = await performWebFetch('https://linkedin.com/', 5000);
    if ('error' in result) {
      expect(result.error).not.toContain('login wall');
    }
  });
});

describe('parseCookiePair', () => {
  test('extracts name=value, ignoring attributes', () => {
    expect(parseCookiePair('JSESSIONID=ABC123; Path=/rpo; Secure; HttpOnly')).toEqual(['JSESSIONID', 'ABC123']);
  });

  test('handles a bare name=value with no attributes', () => {
    expect(parseCookiePair('session=xyz')).toEqual(['session', 'xyz']);
  });

  test('returns null for a malformed cookie with no "="', () => {
    expect(parseCookiePair('not-a-cookie')).toBeNull();
  });
});

describe('cookieHeaderFrom', () => {
  test('joins multiple cookies with "; "', () => {
    const cookies = new Map([
      ['a', '1'],
      ['b', '2'],
    ]);
    expect(cookieHeaderFrom(cookies)).toBe('a=1; b=2');
  });

  test('returns empty string for no cookies', () => {
    expect(cookieHeaderFrom(new Map())).toBe('');
  });
});

describe('fetchFollowingRedirects', () => {
  // Self-contained local server replicating the real pattern found on
  // irs.treasury.gov/rpo/rpo.jsf: no cookie -> mint one + redirect; cookie
  // present -> serve real content. A plain fetch() with default
  // redirect:'follow' loops forever here, since it never re-attaches the
  // Set-Cookie it received on the previous hop (this was the actual bug —
  // see git history / project memory for the CPA bake-off session).
  let server: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  function startCookieDanceServer(): string {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const cookie = req.headers.get('cookie');
        if (url.pathname === '/redirect-to-private') {
          return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:1/' } });
        }
        if (!cookie?.includes('session=granted')) {
          return new Response(null, {
            status: 302,
            headers: { 'Set-Cookie': 'session=granted; Path=/', Location: '/' },
          });
        }
        return new Response('<html><body><p>Contact: real@example.com</p></body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      },
    });
    return `http://127.0.0.1:${server.port}/`;
  }

  // A real local test server necessarily binds to loopback, which the real
  // assertPublicUrl (correctly) always blocks as a redirect target — so
  // these two "does the mechanism work" tests use a permissive stub for
  // hop validation. The SSRF test below uses the real guard on purpose.
  const allowAnyHop = async (url: string) => ({ url: new URL(url) });

  test('follows a cookie-gated redirect chain that a stateless fetch cannot', async () => {
    const url = startCookieDanceServer();
    const result = await fetchFollowingRedirects(new URL(url), 5000, allowAnyHop);
    expect('res' in result).toBe(true);
    if ('res' in result) {
      const body = await result.res.text();
      expect(body).toContain('real@example.com');
    }
  });

  test('gives up cleanly after MAX_REDIRECTS on a server that never accepts the cookie', async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, { status: 302, headers: { 'Set-Cookie': 'x=1', Location: '/' } });
      },
    });
    const result = await fetchFollowingRedirects(new URL(`http://127.0.0.1:${server.port}/`), 5000, allowAnyHop);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('Too many redirects');
  });

  test('re-validates SSRF protection on every redirect hop using the real guard, not just the first', async () => {
    const url = startCookieDanceServer();
    // Uses the DEFAULT (real) validateHop — the starting URL is on loopback
    // too, but fetchFollowingRedirects never checks hop 0 itself (the
    // caller — web_fetch's handler — validates the start URL before ever
    // calling this); it's the /redirect-to-private hop that must get
    // blocked by the real assertPublicUrl.
    const result = await fetchFollowingRedirects(new URL(`${url}redirect-to-private`), 5000);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('Redirect blocked');
  });
});

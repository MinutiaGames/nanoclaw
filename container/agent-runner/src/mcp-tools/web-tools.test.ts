import { afterEach, describe, expect, test } from 'bun:test';

import {
  assertPublicUrl,
  cookieHeaderFrom,
  extractContacts,
  fetchFollowingRedirects,
  htmlToReadableText,
  isPrivateOrLoopbackIPv4,
  isPrivateOrLoopbackIPv6,
  parseCookiePair,
  parseDuckDuckGoResults,
} from './web-tools.js';

describe('parseDuckDuckGoResults', () => {
  const SAMPLE_HTML = `
    <div class="results">
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fjane-doe-cpa&amp;rut=abc">Jane Doe CPA &amp; Associates</a>
          </h2>
          <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fjane-doe-cpa">Certified public accountant serving the metro area. <b>Call</b> today.</a>
        </div>
      </div>
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fsmith-tax">Smith Tax &amp; Bookkeeping</a>
          </h2>
          <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fsmith-tax">Full-service tax prep.</a>
        </div>
      </div>
    </div>
  `;

  test('extracts title, unwrapped url, and snippet', () => {
    const results = parseDuckDuckGoResults(SAMPLE_HTML, 5);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Jane Doe CPA & Associates');
    expect(results[0].url).toBe('https://example.com/jane-doe-cpa');
    expect(results[0].snippet).toContain('Certified public accountant');
  });

  test('respects maxResults', () => {
    expect(parseDuckDuckGoResults(SAMPLE_HTML, 1)).toHaveLength(1);
  });

  test('empty/garbage html returns no results', () => {
    expect(parseDuckDuckGoResults('<html><body>nothing here</body></html>', 5)).toHaveLength(0);
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

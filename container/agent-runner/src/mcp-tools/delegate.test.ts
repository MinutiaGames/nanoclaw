import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { delegateWebResearch, resolveSubAgentModelConfig, runSubAgent } from './delegate.js';

describe('resolveSubAgentModelConfig', () => {
  const original = {
    OPENCODE_PROVIDER: process.env.OPENCODE_PROVIDER,
    OPENCODE_MODEL: process.env.OPENCODE_MODEL,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('errors when OPENCODE_MODEL is unset', () => {
    delete process.env.OPENCODE_MODEL;
    process.env.ANTHROPIC_BASE_URL = 'http://host.docker.internal:1234/v1';
    const result = resolveSubAgentModelConfig();
    expect('error' in result).toBe(true);
  });

  test('errors when ANTHROPIC_BASE_URL is unset', () => {
    process.env.OPENCODE_MODEL = 'lmstudio/google/gemma-4-12b-qat';
    delete process.env.ANTHROPIC_BASE_URL;
    const result = resolveSubAgentModelConfig();
    expect('error' in result).toBe(true);
  });

  test('strips the provider prefix and builds the chat completions URL', () => {
    process.env.OPENCODE_PROVIDER = 'lmstudio';
    process.env.OPENCODE_MODEL = 'lmstudio/google/gemma-4-12b-qat';
    process.env.ANTHROPIC_BASE_URL = 'http://host.docker.internal:1234/v1';
    const result = resolveSubAgentModelConfig();
    expect(result).toEqual({
      chatCompletionsUrl: 'http://host.docker.internal:1234/v1/chat/completions',
      model: 'google/gemma-4-12b-qat',
    });
  });

  test('handles a trailing slash on ANTHROPIC_BASE_URL', () => {
    process.env.OPENCODE_PROVIDER = 'lmstudio';
    process.env.OPENCODE_MODEL = 'lmstudio/foo';
    process.env.ANTHROPIC_BASE_URL = 'http://host.docker.internal:1234/v1/';
    const result = resolveSubAgentModelConfig();
    expect('chatCompletionsUrl' in result && result.chatCompletionsUrl).toBe(
      'http://host.docker.internal:1234/v1/chat/completions',
    );
  });
});

describe('runSubAgent', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  function serveScripted(responses: unknown[]): string {
    let call = 0;
    server = Bun.serve({
      port: 0,
      fetch() {
        const body = responses[Math.min(call, responses.length - 1)];
        call++;
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      },
    });
    return `http://127.0.0.1:${server.port}/chat/completions`;
  }

  test('returns the final answer immediately when the model needs no tools', async () => {
    const url = serveScripted([{ choices: [{ message: { content: 'The answer is 42.' } }] }]);
    const result = await runSubAgent('trivial task', { chatCompletionsUrl: url, model: 'test-model' });
    expect(result).toBe('The answer is 42.');
  });

  test('executes a requested tool call and returns the follow-up final answer', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const url = serveScripted([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"Jane Doe CPA"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: 'Found: Jane Doe, (555) 111-2222' } }] },
    ]);

    const result = await runSubAgent('find Jane Doe CPA contact info', {
      chatCompletionsUrl: url,
      model: 'test-model',
      executeTool: async (name, args) => {
        calls.push({ name, args });
        return 'mock search results: Jane Doe, (555) 111-2222';
      },
    });

    expect(result).toBe('Found: Jane Doe, (555) 111-2222');
    expect(calls).toEqual([{ name: 'web_search', args: { query: 'Jane Doe CPA' } }]);
  });

  // Regression coverage for a real bug found in production: a mid-loop
  // failure (the outer OpenCode MCP client's fixed 60s call timeout,
  // discovered by testing this against a real slow local model) was
  // discarding already-completed tool results and returning a bare error
  // instead of salvaging what had actually been found.
  test('salvages completed tool results when a later turn fails outright (HTTP error)', async () => {
    let call = 0;
    server = Bun.serve({
      port: 0,
      fetch() {
        call++;
        if (call === 1) {
          return Response.json({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"Jane Doe CPA"}' } },
                  ],
                },
              },
            ],
          });
        }
        return new Response('server error', { status: 500 });
      },
    });

    const result = await runSubAgent('find Jane Doe CPA contact info', {
      chatCompletionsUrl: `http://127.0.0.1:${server.port}/`,
      model: 'test-model',
      executeTool: async () => 'Jane Doe: (555) 111-2222, jane@example.com',
    });

    expect(result).toContain('Jane Doe: (555) 111-2222');
    expect(result).toContain('stopped early');
    expect(result).not.toBe('Sub-agent model returned HTTP 500');
  });

  test('salvages completed tool results when a later request times out mid-loop', async () => {
    let call = 0;
    server = Bun.serve({
      port: 0,
      async fetch() {
        call++;
        if (call === 1) {
          return Response.json({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } },
                  ],
                },
              },
            ],
          });
        }
        // Sleeps far longer than the remaining budget below, so the
        // request's own AbortSignal fires mid-flight — simulates the real
        // slow-model scenario that produced the bug (turn 1 fast, turn 2
        // exceeds what's left of the budget).
        await new Promise((r) => setTimeout(r, 2000));
        return Response.json({ choices: [{ message: { content: 'too slow, should not be seen' } }] });
      },
    });

    const result = await runSubAgent('find something', {
      chatCompletionsUrl: `http://127.0.0.1:${server.port}/`,
      model: 'test-model',
      timeoutMs: 600,
      executeTool: async () => 'partial finding: X = Y',
    });

    expect(result).toContain('partial finding: X = Y');
    expect(result).toContain('stopped early');
  });

  test('stops at maxTurns and reports partial findings when the model never finishes', async () => {
    const url = serveScripted([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }],
            },
          },
        ],
      },
    ]);

    const result = await runSubAgent('endless task', {
      chatCompletionsUrl: url,
      model: 'test-model',
      maxTurns: 3,
      executeTool: async () => 'partial result X',
    });

    expect(result).toContain('exceeded its 3-turn budget');
    expect(result).toContain('partial result X');
  });

  test('returns a time-budget message without making a request when timeoutMs has already elapsed', async () => {
    const result = await runSubAgent('task', {
      chatCompletionsUrl: 'http://127.0.0.1:1/unreachable',
      model: 'test-model',
      timeoutMs: -1,
    });
    expect(result).toContain('exceeded its time budget');
  });

  test('surfaces a clear error on HTTP failure from the model endpoint', async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response('nope', { status: 500 }) });
    const result = await runSubAgent('task', {
      chatCompletionsUrl: `http://127.0.0.1:${server.port}/`,
      model: 'test-model',
    });
    expect(result).toContain('HTTP 500');
  });

  test('surfaces a clear error on a malformed (non-JSON) response', async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response('not json', { status: 200 }) });
    const result = await runSubAgent('task', {
      chatCompletionsUrl: `http://127.0.0.1:${server.port}/`,
      model: 'test-model',
    });
    expect(result).toContain('malformed');
  });

  test('surfaces a clear error when the response has no choices', async () => {
    const url = serveScripted([{}]);
    const result = await runSubAgent('task', { chatCompletionsUrl: url, model: 'test-model' });
    expect(result).toContain('empty response');
  });

  test('falls back to real config resolution when no explicit endpoint/model is passed', async () => {
    const savedModel = process.env.OPENCODE_MODEL;
    const savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
    delete process.env.OPENCODE_MODEL;
    delete process.env.ANTHROPIC_BASE_URL;
    try {
      const result = await runSubAgent('task with no config');
      expect(result).toContain('No local model configured');
    } finally {
      if (savedModel === undefined) delete process.env.OPENCODE_MODEL;
      else process.env.OPENCODE_MODEL = savedModel;
      if (savedBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
    }
  });
});

describe('delegate_web_research tool', () => {
  test('rejects an empty task without making any request', async () => {
    const result = await delegateWebResearch.handler({ task: '' });
    expect(result.isError).toBe(true);
  });

  test('rejects a missing task', async () => {
    const result = await delegateWebResearch.handler({});
    expect(result.isError).toBe(true);
  });

  test('tool schema requires task as a string', () => {
    expect(delegateWebResearch.tool.name).toBe('delegate_web_research');
    expect(delegateWebResearch.tool.inputSchema.required).toEqual(['task']);
  });
});

describe('runSubAgent — reproduces the exact behavior validated with the mock', () => {
  // Regression coverage for the specific finding from the mock-tool test run:
  // when a sub-task only turns up one real result but multiple were asked
  // for, the caller (the top-level model) should see exactly what came
  // back — this test just confirms runSubAgent faithfully returns the
  // model's own final text rather than post-processing/padding it.
  let server: ReturnType<typeof Bun.serve> | null = null;
  beforeEach(() => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          choices: [
            {
              message: {
                content:
                  '1. Jane Sample, CPA — Testville — not found — not found\n2. not found\n3. not found\n4. not found\n5. not found',
              },
            },
          ],
        }),
    });
  });
  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  test('returns the model final text verbatim, without inventing or padding entries', async () => {
    const result = await runSubAgent('find 5 CPAs', {
      chatCompletionsUrl: `http://127.0.0.1:${server!.port}/`,
      model: 'test-model',
    });
    expect(result).toContain('Jane Sample');
    expect(result.match(/not found/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

/**
 * delegate_web_research — Wizard-of-Oz stand-in for a future sub-agent.
 *
 * Returns a fixed, deliberately fake response regardless of input. The goal
 * right now isn't to do real work — it's to observe whether the top-level
 * model (a) reaches for delegation at all instead of doing everything
 * itself, (b) passes a sensible narrow task description, and (c) actually
 * uses the returned text in its final answer rather than ignoring it or
 * inventing its own.
 *
 * The mock data is intentionally unmistakable (nobody could confuse "Jane
 * Sample / Testville / mock-test-response.invalid" for a real lookup) — a
 * realistic-looking mock would make it impossible to tell whether a later
 * fabricated answer came from the tool or from the model hallucinating on
 * its own, which is exactly the failure mode this is meant to catch (see
 * the CPA bake-off: a model confabulated a full fake result set from
 * nothing more than once).
 *
 * Once the real sub-agent exists, this file's handler is what gets
 * replaced — the tool name/schema the top-level model already knows how
 * to call should not need to change.
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const MOCK_RESPONSE = `MOCK SUB-AGENT RESPONSE (not real data — testing orchestration only):
Name: Jane Sample, CPA
City: Testville
Phone: (555) 000-1234
Email: jane@mock-test-response.invalid`;

export const delegateWebResearch: McpToolDefinition = {
  tool: {
    name: 'delegate_web_research',
    description:
      'Delegate a narrow, self-contained web research task (e.g. "find the phone number and email for Jane Doe, CPA in Marion IA") to a sub-agent and get back a distilled answer. Use this instead of doing the search/fetch/browse yourself when a task is well-scoped enough to hand off — the sub-agent runs independently and only its final answer re-enters this conversation, so the raw pages, search noise, and dead ends it works through never bloat your own context.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task: {
          type: 'string',
          description: 'A specific, narrow, self-contained task description — not the whole original request.',
        },
      },
      required: ['task'],
    },
  },
  async handler(args) {
    const task = (args.task as string)?.trim();
    if (!task) return { content: [{ type: 'text' as const, text: 'Error: task is required' }], isError: true };

    log(`delegate_web_research (MOCK): "${task}"`);
    return { content: [{ type: 'text' as const, text: MOCK_RESPONSE }] };
  },
};

registerTools([delegateWebResearch]);

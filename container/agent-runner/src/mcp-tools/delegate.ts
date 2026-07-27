/**
 * delegate_web_research — a bounded, isolated sub-agent for narrow web
 * research tasks, replacing the earlier Wizard-of-Oz mock now that the
 * orchestration pattern has been validated against it (see project memory
 * — the mock run relayed its fixed fake answer correctly and, critically,
 * reported "not found" for slots it had no data for rather than
 * fabricating plausible-looking entries).
 *
 * Deliberately NOT the full OpenCode framework: it talks directly to the
 * same local model via its OpenAI-compatible chat completions endpoint,
 * with its own minimal tool-calling loop and exactly two tools
 * (web_search, web_fetch — the same logic web-tools.ts's MCP tools use,
 * called in-process rather than through MCP a second time). No
 * agent-browser, no skill catalog, no `question` tool, no recursive access
 * to delegate_web_research itself — a narrow sub-task only helps if it's
 * genuinely narrower than what the top-level model was struggling with,
 * and every tool-selection/looping failure found during the CPA bake-off
 * involved a model juggling multiple heterogeneous tool patterns (browser
 * automation, raw fetch, narrating via send_message) in one continuous
 * context. One tool pattern, a hard turn cap, and a hard wall-clock cap
 * bound the blast radius of exactly the failure modes observed there.
 */
import { performWebFetch, performWebSearch } from './web-tools.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const MAX_SUBAGENT_TURNS = 6;
// OpenCode's own MCP client hard-kills a tool call at 60s by default
// ("MCP error -32001: Request timed out" — confirmed via a real timed-out
// call, duration 60005ms), and the per-server config field for this is a
// known-broken path upstream. Raised via the global `experimental.
// mcp_timeout` workaround in buildOpenCodeConfig (opencode.ts) to 300s, so
// this budget has real headroom now — but it must still stay safely under
// that outer ceiling, or the graceful degradation below never gets a
// chance to run before the outer timeout kills the call outright.
//
// Raised 180s -> 250s (2026-07-27) after real per-request timing data
// showed the 60s-per-request cap was rarely the actual bottleneck (9/12
// real requests completed in 4-56s, well under it) — the sub-agent was
// instead running out of its own TOTAL budget after just 3-4 such
// requests, since each one alone can take 25-55s on this hardware. 250s
// leaves a 50s margin under the outer 300s ceiling above.
const SUBAGENT_TIMEOUT_MS = 250_000;
const SUBAGENT_REQUEST_TIMEOUT_MS = 60_000;
const SUBAGENT_MAX_TOKENS = 800;

const SUBAGENT_SYSTEM_PROMPT = `You are a narrow research sub-agent. You will be given ONE specific task.
Use the web_search and web_fetch tools to find exactly what's asked — nothing more.
When you have an answer, or have genuinely exhausted reasonable options, respond with plain text only (no tool call) stating the answer concisely and factually.
If you cannot find something, say so explicitly — write "not found" for the specific missing piece rather than guessing or inventing a plausible-sounding answer.
Do not ask questions or request clarification — do your best with the task as given, and do not narrate your steps.`;

const SUBAGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web and return titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          maxResults: { type: 'integer', description: 'Max results (default 5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a specific URL and return its readable text plus any emails/phone numbers found on it.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          maxChars: { type: 'integer', description: 'Max characters of text to return (default 5000)' },
        },
        required: ['url'],
      },
    },
  },
] as const;

interface SubAgentToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface SubAgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: SubAgentToolCall[];
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: SubAgentToolCall[] } }>;
}

export type SubAgentToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

const defaultToolExecutor: SubAgentToolExecutor = async (name, args) => {
  if (name === 'web_search') {
    const result = await performWebSearch(args.query as string, Number(args.maxResults));
    return 'error' in result ? `Error: ${result.error}` : result.text;
  }
  if (name === 'web_fetch') {
    const result = await performWebFetch(args.url as string, Number(args.maxChars));
    return 'error' in result ? `Error: ${result.error}` : result.text;
  }
  return `Error: unknown tool "${name}"`;
};

/** Reads which local model/endpoint to use from the same env vars opencode.ts's buildOpenCodeConfig reads. */
export function resolveSubAgentModelConfig(): { chatCompletionsUrl: string; model: string } | { error: string } {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = process.env.OPENCODE_MODEL;
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (!model || !baseUrl) {
    return { error: 'No local model configured (OPENCODE_MODEL/ANTHROPIC_BASE_URL unset) — cannot run a sub-agent.' };
  }
  const strippedModel = model.replace(new RegExp(`^${provider}/`), '');
  return { chatCompletionsUrl: `${baseUrl.replace(/\/$/, '')}/chat/completions`, model: strippedModel };
}

// Directed at the TOP-LEVEL model reading this tool's result, not the sub-agent
// (whose own loop already ended by the time this text is produced). Repeated
// here — not just in the tool description — because the description is easy
// to lose track of once a real task is underway, and this is the moment the
// top-level model is actually deciding what to do next. See project memory
// (2026-07-27): every model tested has, at some point, treated a failed/
// partial delegate result as something to complete itself — inventing a
// plausible-sounding answer (wrong city, fabricated contact) rather than
// reporting the gap. The top-level model's job is orchestration, not research.
//
// Deliberately a hard "one attempt, then stop" rule, NOT "retry, then stop"
// (changed 2026-07-27). A "retry" framing was tried first and backfired: the
// top-level model retried the exact request once as instructed, but when
// that failed too it kept going — rephrasing the task twice more, and on the
// last attempt injecting its OWN guessed city into the delegate task itself
// ("...near Davenport/Marion, IA") rather than reporting the gap. The
// sub-agent then correctly, honestly found real Davenport businesses for
// that invented premise — no hallucination in the sub-agent at all, but a
// wrong final answer wrapped in real-looking data, which is harder to catch
// than an outright fabrication. Permitting any retry apparently reads as
// license to keep iterating/adjusting the query until something comes back;
// removing that permission entirely closes the loophole.
const FAILURE_GUIDANCE =
  'This is a FAILED delegate call, not a completed answer. Do not treat anything below as verified, ' +
  'do not guess or invent the missing information, and do not fall back to searching/fetching this ' +
  'yourself. Do NOT call delegate_web_research again for this same piece of research — one attempt only. ' +
  'Report this specific item as unavailable and move on, or stop and flag the failure if it blocks the ' +
  'whole task.';

function summarizePartial(messages: SubAgentMessage[], reason: string): string {
  const toolResults = messages
    .filter((m) => m.role === 'tool' && m.content)
    .map((m) => m.content as string);
  if (toolResults.length === 0) return `Sub-agent stopped early (${reason}) with no findings. ${FAILURE_GUIDANCE}`;
  return (
    `Sub-agent stopped early (${reason}). ${FAILURE_GUIDANCE}\n\n` +
    `Unverified raw data gathered before the failure (do not present as fact):\n\n${toolResults.join('\n\n')}`
  );
}

/**
 * Any mid-loop failure (request error, timeout, bad HTTP status, malformed
 * response) should still salvage completed tool results rather than
 * discard them — a request timing out on turn 3 doesn't undo the
 * successful web_search from turn 1. Only fall back to a bare error when
 * there's genuinely nothing gathered yet to report instead. Either way the
 * result is a FAILURE, not a completed answer — see FAILURE_GUIDANCE.
 */
function failOrSalvage(messages: SubAgentMessage[], bareError: string, salvageReason: string): string {
  const hasFindings = messages.some((m) => m.role === 'tool' && m.content);
  return hasFindings ? summarizePartial(messages, salvageReason) : `${bareError} ${FAILURE_GUIDANCE}`;
}

export interface RunSubAgentOptions {
  chatCompletionsUrl?: string;
  model?: string;
  executeTool?: SubAgentToolExecutor;
  maxTurns?: number;
  timeoutMs?: number;
}

export async function runSubAgent(task: string, opts: RunSubAgentOptions = {}): Promise<string> {
  const config =
    opts.chatCompletionsUrl && opts.model
      ? { chatCompletionsUrl: opts.chatCompletionsUrl, model: opts.model }
      : resolveSubAgentModelConfig();
  if ('error' in config) return config.error;

  const executeTool = opts.executeTool ?? defaultToolExecutor;
  const maxTurns = opts.maxTurns ?? MAX_SUBAGENT_TURNS;
  const timeoutMs = opts.timeoutMs ?? SUBAGENT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const messages: SubAgentMessage[] = [
    { role: 'system', content: SUBAGENT_SYSTEM_PROMPT },
    { role: 'user', content: task },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return summarizePartial(messages, 'exceeded its time budget');

    let res: Response;
    const requestBudgetMs = Math.min(remaining, SUBAGENT_REQUEST_TIMEOUT_MS);
    const requestStarted = Date.now();
    try {
      res = await fetch(config.chatCompletionsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          messages,
          tools: SUBAGENT_TOOLS,
          max_tokens: SUBAGENT_MAX_TOKENS,
        }),
        signal: AbortSignal.timeout(requestBudgetMs),
      });
      log(`sub-agent turn ${turn}: model request took ${Date.now() - requestStarted}ms (budget ${requestBudgetMs}ms)`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      log(
        `sub-agent turn ${turn}: model request FAILED after ${Date.now() - requestStarted}ms ` +
          `(budget ${requestBudgetMs}ms): ${reason}`,
      );
      return failOrSalvage(messages, `Sub-agent request failed: ${reason}`, `a request failed (${reason})`);
    }
    if (!res.ok) {
      return failOrSalvage(messages, `Sub-agent model returned HTTP ${res.status}`, `model returned HTTP ${res.status}`);
    }

    let data: ChatCompletionResponse;
    try {
      data = (await res.json()) as ChatCompletionResponse;
    } catch {
      return failOrSalvage(
        messages,
        'Sub-agent got a malformed (non-JSON) response from the model.',
        'got a malformed response',
      );
    }
    const message = data.choices?.[0]?.message;
    if (!message) {
      return failOrSalvage(messages, 'Sub-agent got an empty response from the model.', 'got an empty response');
    }

    const toolCalls = message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      return message.content?.trim() || 'Sub-agent finished with no answer.';
    }

    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls });

    for (const call of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        /* malformed arguments — tool executor will just see an empty object */
      }
      const result = await executeTool(call.function.name, args);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }

  return summarizePartial(messages, `exceeded its ${maxTurns}-turn budget`);
}

export const delegateWebResearch: McpToolDefinition = {
  tool: {
    name: 'delegate_web_research',
    description:
      'Delegate a narrow, self-contained web research task (e.g. "find the phone number and email for Jane Doe, CPA in Marion IA") to a sub-agent and get back a distilled answer. Use this instead of doing the search/fetch/browse yourself when a task is well-scoped enough to hand off — the sub-agent runs independently and only its final answer re-enters this conversation, so the raw pages, search noise, and dead ends it works through never bloat your own context. Your role is orchestration and planning, not research — if this tool times out, fails, or comes back with no answer, do NOT fall back to searching/fetching it yourself, do NOT guess or invent an answer to fill the gap, and do NOT call it again for the same piece of research (one attempt per item — do not rephrase or add assumptions and try again). Report that specific item as unavailable and move on, or stop and flag the failure if it blocks the whole task.',
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

    log(`delegate_web_research: "${task}"`);
    const result = await runSubAgent(task);
    log(`delegate_web_research: done, ${result.length} chars`);
    return { content: [{ type: 'text' as const, text: result }] };
  },
};

registerTools([delegateWebResearch]);

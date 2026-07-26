import { describe, expect, test } from 'bun:test';

import { delegateWebResearch } from './delegate.js';

describe('delegate_web_research (mock)', () => {
  test('returns the same fixed mock response regardless of task content', async () => {
    const a = await delegateWebResearch.handler({ task: 'find the phone number for Jane Doe CPA in Marion IA' });
    const b = await delegateWebResearch.handler({ task: 'completely different task about something else entirely' });

    expect(a.content[0]).toEqual(b.content[0]);
    expect((a.content[0] as { text: string }).text).toContain('MOCK SUB-AGENT RESPONSE');
    expect((a.content[0] as { text: string }).text).toContain('Jane Sample');
    expect((a.content[0] as { text: string }).text).toContain('mock-test-response.invalid');
  });

  test('rejects an empty task', async () => {
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

import { describe, it, expect } from 'vitest';

import { detectRepeatedToolCall, detectSameToolStreak, type ToolCallRecord } from './agent-watchdog';

function call(tool: string, input: unknown): ToolCallRecord {
  return { tool, inputJson: JSON.stringify(input) };
}

describe('detectRepeatedToolCall', () => {
  it('returns null when history is shorter than threshold', () => {
    const history = [call('skill', { name: 'agent-browser' }), call('skill', { name: 'agent-browser' })];
    expect(detectRepeatedToolCall(history, 3)).toBeNull();
  });

  it('returns null when the tail calls differ', () => {
    const history = [
      call('bash', { command: 'agent-browser open x' }),
      call('bash', { command: 'agent-browser snapshot -i' }),
      call('bash', { command: 'agent-browser click @e1' }),
    ];
    expect(detectRepeatedToolCall(history, 3)).toBeNull();
  });

  it('detects the exact repeated-skill-reload pattern observed with gemma', () => {
    const history = Array.from({ length: 24 }, () => call('skill', { name: 'agent-browser' }));
    const result = detectRepeatedToolCall(history, 3);
    expect(result).toEqual({ tool: 'skill', inputJson: JSON.stringify({ name: 'agent-browser' }), count: 24 });
  });

  it('detects the exact repeated-fetch pattern observed with qwen3-8b', () => {
    const url = 'https://www.yellowpages.com/search?search=cpa+zip+52302&geo=52302';
    const history = [
      call('web_fetch', { url: 'https://irs.treasury.gov/rpo/rpo.jsf', maxChars: 5000 }),
      ...Array.from({ length: 5 }, () => call('web_fetch', { url, maxChars: 5000 })),
    ];
    const result = detectRepeatedToolCall(history, 3);
    expect(result?.count).toBe(5);
    expect(result?.tool).toBe('web_fetch');
  });

  it('does not trigger on different arguments to the same tool (legitimate varied use)', () => {
    const history = [
      call('web_search', { query: 'CPA near 52302' }),
      call('web_search', { query: 'CPA Marion Iowa contact' }),
      call('web_search', { query: 'Jane Doe CPA phone number' }),
    ];
    expect(detectRepeatedToolCall(history, 3)).toBeNull();
  });

  it('only counts the trailing streak, not an earlier one broken by a different call', () => {
    const history = [
      call('bash', { command: 'a' }),
      call('bash', { command: 'a' }),
      call('bash', { command: 'a' }),
      call('bash', { command: 'b' }),
      call('bash', { command: 'c' }),
      call('bash', { command: 'c' }),
      call('bash', { command: 'c' }),
    ];
    const result = detectRepeatedToolCall(history, 3);
    expect(result).toEqual({ tool: 'bash', inputJson: JSON.stringify({ command: 'c' }), count: 3 });
  });

  it('rejects a threshold below 2 as meaningless', () => {
    const history = [call('bash', { command: 'a' })];
    expect(detectRepeatedToolCall(history, 1)).toBeNull();
    expect(detectRepeatedToolCall(history, 0)).toBeNull();
  });
});

describe('detectSameToolStreak', () => {
  it('returns null when history is shorter than threshold', () => {
    const history = [call('send_message', { text: 'a' }), call('send_message', { text: 'b' })];
    expect(detectSameToolStreak(history, 3)).toBeNull();
  });

  it('returns null when the tail calls use different tools', () => {
    const history = [call('skill', { name: 'agent-browser' }), call('send_message', { text: 'a' }), call('bash', { command: 'x' })];
    expect(detectSameToolStreak(history, 3)).toBeNull();
  });

  it('detects the exact nemotron pattern: same tool, different arguments each time', () => {
    const history = [
      call('skill', { name: 'agent-browser' }),
      call('send_message', { to: 'local-cli', text: 'Opening IRS CPAs directory page.' }),
      call('send_message', { to: 'local-cli', text: 'Executing agent-browser open https://irs.treasury.gov/rpo/rpo.jsf.' }),
      call('send_message', { to: 'local-cli', text: 'Finding CPA checkbox.' }),
      call('send_message', { to: 'local-cli', text: 'Filling ZIP 52302.' }),
      call('send_message', { to: 'local-cli', text: 'Selecting 25 miles.' }),
      call('send_message', { to: 'local-cli', text: 'Clicking search.' }),
      call('send_message', { to: 'local-cli', text: 'Waiting for network idle.' }),
      call('send_message', { to: 'local-cli', text: 'Taking full page screenshot.' }),
    ];
    const result = detectSameToolStreak(history, 6);
    expect(result?.tool).toBe('send_message');
    expect(result?.count).toBe(8);
  });

  it('does not flag healthy varied use below the soft threshold', () => {
    const history = [
      call('web_search', { query: 'CPA near 52302' }),
      call('web_search', { query: 'CPA Marion Iowa contact' }),
      call('web_search', { query: 'Jane Doe CPA phone number' }),
    ];
    expect(detectSameToolStreak(history, 6)).toBeNull();
  });

  it('rejects a threshold below 2 as meaningless', () => {
    const history = [call('bash', { command: 'a' })];
    expect(detectSameToolStreak(history, 1)).toBeNull();
    expect(detectSameToolStreak(history, 0)).toBeNull();
  });
});

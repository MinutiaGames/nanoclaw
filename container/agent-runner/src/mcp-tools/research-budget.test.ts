import { afterEach, describe, expect, test } from 'bun:test';

import {
  __resetResearchBudgetForTests,
  checkWebFetchBudget,
  checkWebSearchBudget,
  setResearchPhase,
} from './research-budget.js';

afterEach(() => {
  __resetResearchBudgetForTests();
});

describe('checkWebSearchBudget / checkWebFetchBudget — no phase set', () => {
  test('never blocks before setResearchPhase has been called', () => {
    for (let i = 0; i < 20; i++) {
      expect(checkWebSearchBudget()).toBeNull();
      expect(checkWebFetchBudget()).toBeNull();
    }
  });
});

describe('phase1 — uncapped', () => {
  test('never blocks web_search or web_fetch, however many calls', () => {
    setResearchPhase('phase1');
    for (let i = 0; i < 20; i++) {
      expect(checkWebSearchBudget()).toBeNull();
      expect(checkWebFetchBudget()).toBeNull();
    }
  });
});

describe('phase2 — capped at 6 web_search and 6 web_fetch', () => {
  test('allows exactly 6 web_search calls, blocks the 7th onward', () => {
    setResearchPhase('phase2');
    for (let i = 0; i < 6; i++) {
      expect(checkWebSearchBudget()).toBeNull();
    }
    const seventh = checkWebSearchBudget();
    expect(seventh).not.toBeNull();
    expect(seventh).toContain('web_search budget exceeded');
    expect(seventh).toContain('needs_more_research');

    // Stays blocked, doesn't reset itself.
    const eighth = checkWebSearchBudget();
    expect(eighth).toContain('web_search budget exceeded');
  });

  test('allows exactly 6 web_fetch calls, blocks the 7th onward, independently of web_search', () => {
    setResearchPhase('phase2');
    for (let i = 0; i < 6; i++) {
      expect(checkWebSearchBudget()).toBeNull();
    }
    expect(checkWebSearchBudget()).not.toBeNull(); // search budget exhausted

    // web_fetch has its own separate counter — still fully available.
    for (let i = 0; i < 6; i++) {
      expect(checkWebFetchBudget()).toBeNull();
    }
    const seventh = checkWebFetchBudget();
    expect(seventh).not.toBeNull();
    expect(seventh).toContain('web_fetch budget exceeded');
  });

  test('a fresh setResearchPhase call resets both counters', () => {
    setResearchPhase('phase2');
    for (let i = 0; i < 6; i++) checkWebSearchBudget();
    expect(checkWebSearchBudget()).not.toBeNull();

    setResearchPhase('phase2');
    expect(checkWebSearchBudget()).toBeNull();
  });

  test('switching from phase2 to phase1 lifts the cap', () => {
    setResearchPhase('phase2');
    for (let i = 0; i < 6; i++) checkWebSearchBudget();
    expect(checkWebSearchBudget()).not.toBeNull();

    setResearchPhase('phase1');
    for (let i = 0; i < 20; i++) {
      expect(checkWebSearchBudget()).toBeNull();
    }
  });
});

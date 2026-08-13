import { afterEach, describe, expect, test } from 'bun:test';

import {
  __resetResearchBudgetForTests,
  checkContactLock,
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

describe('checkContactLock', () => {
  test('never blocks before setResearchPhase has been called', () => {
    expect(checkContactLock(111)).toBeNull();
    expect(checkContactLock(222)).toBeNull();
  });

  test('phase1 is never locked, even across different contact_ids', () => {
    setResearchPhase('phase1');
    expect(checkContactLock(111)).toBeNull();
    expect(checkContactLock(222)).toBeNull();
    expect(checkContactLock(333)).toBeNull();
  });

  test('phase2: first contact_id locks, repeat calls for it are always allowed', () => {
    setResearchPhase('phase2');
    expect(checkContactLock(111)).toBeNull();
    expect(checkContactLock(111)).toBeNull();
    expect(checkContactLock(111)).toBeNull();
  });

  test('phase2: a different contact_id after the lock is rejected with the locked id named', () => {
    setResearchPhase('phase2');
    expect(checkContactLock(111)).toBeNull();

    const rejection = checkContactLock(222);
    expect(rejection).not.toBeNull();
    expect(rejection).toContain('locked to contact_id 111');
    expect(rejection).toContain('222');

    // Stays locked — doesn't get overwritten by the rejected attempt.
    expect(checkContactLock(111)).toBeNull();
    expect(checkContactLock(333)).not.toBeNull();
  });

  test('a fresh setResearchPhase(\'phase2\') call clears the lock', () => {
    setResearchPhase('phase2');
    checkContactLock(111);
    expect(checkContactLock(222)).not.toBeNull();

    setResearchPhase('phase2');
    expect(checkContactLock(222)).toBeNull();
  });

  test('the web_search/web_fetch budget and the contact lock are independent', () => {
    setResearchPhase('phase2');
    expect(checkContactLock(111)).toBeNull();
    for (let i = 0; i < 6; i++) checkWebSearchBudget();
    expect(checkWebSearchBudget()).not.toBeNull(); // search budget exhausted

    // Contact lock unaffected by the search budget being exhausted.
    expect(checkContactLock(111)).toBeNull();
    expect(checkContactLock(222)).not.toBeNull();
  });
});

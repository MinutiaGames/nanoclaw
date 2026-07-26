/**
 * Regression test for the idle-timeout hang: OpenCode's SSE stream doesn't
 * reliably honor `.return()` to interrupt an in-flight `.next()` read, so
 * the query loop must be able to bail out via a race rather than relying on
 * the stream to cooperate. See raceNextAgainstTimeout in opencode.ts.
 */
import { describe, expect, test } from 'bun:test';

import { raceNextAgainstTimeout } from './opencode.js';

function neverResolves<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('raceNextAgainstTimeout', () => {
  test('resolves with the next value when it settles before the timeout', async () => {
    const next = Promise.resolve({ value: 'event', done: false });
    const timeoutSignal = neverResolves<void>();

    const outcome = await raceNextAgainstTimeout(next, timeoutSignal);

    expect(outcome).toEqual({ timedOut: false, value: { value: 'event', done: false } });
  });

  test('resolves as timed-out when the signal fires, even if next never settles', async () => {
    const next = neverResolves<{ value: string; done: boolean }>();
    let signal: () => void;
    const timeoutSignal = new Promise<void>((resolve) => {
      signal = resolve;
    });

    const racePromise = raceNextAgainstTimeout(next, timeoutSignal);
    signal!();
    const outcome = await racePromise;

    expect(outcome).toEqual({ timedOut: true });
  });

  test('does not block on a never-resolving next promise once timed out', async () => {
    const next = neverResolves<unknown>();
    const timeoutSignal = Promise.resolve();

    const start = Date.now();
    const outcome = await raceNextAgainstTimeout(next, timeoutSignal);
    const elapsed = Date.now() - start;

    expect(outcome).toEqual({ timedOut: true });
    expect(elapsed).toBeLessThan(1000);
  });

  test('a rejected next promise propagates as a rejection, not a timeout', async () => {
    const next = Promise.reject(new Error('boom'));
    const timeoutSignal = neverResolves<void>();

    await expect(raceNextAgainstTimeout(next, timeoutSignal)).rejects.toThrow('boom');
  });
});

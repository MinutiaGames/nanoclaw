import { describe, it, expect } from 'vitest';

import { splitCsvLine, parseLatestReading, SustainedThresholdTracker } from './gpu-thermal-watchdog';

describe('splitCsvLine', () => {
  it('strips surrounding quotes from each field', () => {
    expect(splitCsvLine('"Date","Time","GPU Temperature [C]"')).toEqual(['Date', 'Time', 'GPU Temperature [C]']);
  });

  it('leaves unquoted numeric fields alone', () => {
    expect(splitCsvLine('28.07.2026,15:32:10,54.0')).toEqual(['28.07.2026', '15:32:10', '54.0']);
  });
});

describe('parseLatestReading', () => {
  const header = 'Date,Time,"GPU Temperature [C]","GPU Hot Spot Temperature [C]"';

  it('finds the column by substring and reads the last row', () => {
    const csv = [header, '28.07.2026,15:32:10,54.0,58.0', '28.07.2026,15:32:12,72.0,91.0'].join('\n');
    const reading = parseLatestReading(csv, 'GPU Hot Spot Temperature');
    expect(reading).toEqual({ value: 91.0, dateTime: '28.07.2026 15:32:12' });
  });

  it('is case-insensitive on the column substring', () => {
    const csv = [header, '28.07.2026,15:32:10,54.0,58.0'].join('\n');
    expect(parseLatestReading(csv, 'hot spot temperature')?.value).toBe(58.0);
  });

  it('returns null when the column is not found', () => {
    const csv = [header, '28.07.2026,15:32:10,54.0,58.0'].join('\n');
    expect(parseLatestReading(csv, 'Nonexistent Sensor')).toBeNull();
  });

  it('returns null when there is only a header row', () => {
    expect(parseLatestReading(header, 'GPU Temperature')).toBeNull();
  });

  it('returns null when the last row value is not numeric', () => {
    const csv = [header, '28.07.2026,15:32:10,N/A,N/A'].join('\n');
    expect(parseLatestReading(csv, 'GPU Temperature')).toBeNull();
  });

  it('ignores trailing blank lines', () => {
    const csv = [header, '28.07.2026,15:32:10,54.0,58.0', '', ''].join('\n');
    expect(parseLatestReading(csv, 'GPU Temperature')?.value).toBe(54.0);
  });

  it('falls back to the previous complete row when the last row is torn (fewer fields than the header)', () => {
    const csv = [
      header,
      '28.07.2026,15:32:10,54.0,58.0',
      '28.07.2026,15:32:12,72.0', // torn: HWiNFO caught mid-write, trailing field missing
    ].join('\n');
    expect(parseLatestReading(csv, 'GPU Hot Spot Temperature')).toEqual({
      value: 58.0,
      dateTime: '28.07.2026 15:32:10',
    });
  });

  it('gives up after too many consecutive torn rows rather than scanning the whole file', () => {
    const goodRow = '28.07.2026,15:32:10,54.0,58.0';
    const tornRow = '28.07.2026,15:32:12,72.0';
    const csv = [header, goodRow, tornRow, tornRow, tornRow, tornRow, tornRow].join('\n');
    expect(parseLatestReading(csv, 'GPU Hot Spot Temperature')).toBeNull();
  });
});

describe('SustainedThresholdTracker', () => {
  it('does not trigger on a single reading above threshold', () => {
    const tracker = new SustainedThresholdTracker(100, 30_000);
    expect(tracker.update(105, 0)).toBe(false);
  });

  it('does not trigger until the sustained duration has elapsed', () => {
    const tracker = new SustainedThresholdTracker(100, 30_000);
    expect(tracker.update(105, 0)).toBe(false);
    expect(tracker.update(105, 10_000)).toBe(false);
    expect(tracker.update(105, 29_999)).toBe(false);
  });

  it('triggers once the value has stayed at/above threshold for the full duration', () => {
    const tracker = new SustainedThresholdTracker(100, 30_000);
    expect(tracker.update(105, 0)).toBe(false);
    expect(tracker.update(105, 30_000)).toBe(true);
  });

  it('resets the clock if the value dips below threshold', () => {
    const tracker = new SustainedThresholdTracker(100, 30_000);
    expect(tracker.update(105, 0)).toBe(false);
    expect(tracker.update(95, 15_000)).toBe(false);
    // Back above threshold, but the sustained clock restarts from here.
    expect(tracker.update(105, 20_000)).toBe(false);
    expect(tracker.update(105, 40_000)).toBe(false);
    expect(tracker.update(105, 50_000)).toBe(true);
  });

  it('treats exactly-at-threshold as sustained-high, not below', () => {
    const tracker = new SustainedThresholdTracker(100, 30_000);
    expect(tracker.update(100, 0)).toBe(false);
    expect(tracker.update(100, 30_000)).toBe(true);
  });
});

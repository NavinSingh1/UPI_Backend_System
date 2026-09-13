const { periodKey, nextRunDate } = require('../../src/utils/recurrence');

describe('periodKey', () => {
  test('formats a stable YYYY-MM-DD key', () => {
    expect(periodKey(new Date(2026, 8, 9, 13, 45))).toBe('2026-09-09');
    expect(periodKey(new Date(2026, 0, 1))).toBe('2026-01-01');
  });

  test('is stable across times within the same day', () => {
    const morning = new Date(2026, 8, 9, 0, 1);
    const night = new Date(2026, 8, 9, 23, 59);
    // This is what makes a restarted worker idempotent for the same period
    expect(periodKey(morning)).toBe(periodKey(night));
  });
});

describe('nextRunDate', () => {
  test('DAILY advances one day', () => {
    const next = nextRunDate(new Date(2026, 8, 9), 'DAILY');
    expect(periodKey(next)).toBe('2026-09-10');
  });

  test('WEEKLY advances seven days', () => {
    const next = nextRunDate(new Date(2026, 8, 9), 'WEEKLY');
    expect(periodKey(next)).toBe('2026-09-16');
  });

  test('MONTHLY advances one month', () => {
    const next = nextRunDate(new Date(2026, 8, 9), 'MONTHLY');
    expect(periodKey(next)).toBe('2026-10-09');
  });

  test('MONTHLY clamps to the last day of a shorter month', () => {
    // Jan 31 + 1 month must land on Feb 28 (2026 is not a leap year),
    // not roll forward into March like plain Date arithmetic would
    const next = nextRunDate(new Date(2026, 0, 31), 'MONTHLY');
    expect(periodKey(next)).toBe('2026-02-28');
  });

  test('MONTHLY handles a leap February', () => {
    const next = nextRunDate(new Date(2028, 0, 31), 'MONTHLY');
    expect(periodKey(next)).toBe('2028-02-29');
  });

  test('MONTHLY rolls over the year boundary', () => {
    const next = nextRunDate(new Date(2026, 11, 15), 'MONTHLY');
    expect(periodKey(next)).toBe('2027-01-15');
  });

  test('DAILY rolls over month and year boundaries', () => {
    expect(periodKey(nextRunDate(new Date(2026, 0, 31), 'DAILY'))).toBe('2026-02-01');
    expect(periodKey(nextRunDate(new Date(2026, 11, 31), 'DAILY'))).toBe('2027-01-01');
  });

  test('rejects an unknown frequency', () => {
    expect(() => nextRunDate(new Date(), 'HOURLY')).toThrow(/Unknown frequency/);
  });

  test('always moves forward in time', () => {
    const from = new Date(2026, 5, 15);
    ['DAILY', 'WEEKLY', 'MONTHLY'].forEach((frequency) => {
      expect(nextRunDate(from, frequency).getTime()).toBeGreaterThan(from.getTime());
    });
  });
});

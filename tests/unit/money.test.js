const { rupeesToPaise, paiseToRupees, formatPaise, splitPaise } = require('../../src/utils/money');

describe('rupeesToPaise', () => {
  test('converts whole rupees', () => {
    expect(rupeesToPaise(100)).toBe(10000);
    expect(rupeesToPaise('1')).toBe(100);
    expect(rupeesToPaise(0)).toBe(0);
  });

  test('handles one and two decimal places correctly', () => {
    // The classic bug: "12.5" must be 1250 paise, not 125
    expect(rupeesToPaise('12.5')).toBe(1250);
    expect(rupeesToPaise('12.50')).toBe(1250);
    expect(rupeesToPaise('12.05')).toBe(1205);
    expect(rupeesToPaise(149.99)).toBe(14999);
  });

  test('avoids floating-point drift that rupees * 100 would introduce', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004; integer paise are exact
    expect(rupeesToPaise('0.1') + rupeesToPaise('0.2')).toBe(rupeesToPaise('0.3'));
    expect(rupeesToPaise('1.15')).toBe(115); // 1.15 * 100 === 114.99999999999999
    expect(rupeesToPaise('4.35')).toBe(435); // 4.35 * 100 === 434.99999999999994
  });

  test('rejects more than two decimal places', () => {
    expect(() => rupeesToPaise('10.999')).toThrow(/2 decimal places/);
    expect(() => rupeesToPaise(0.30000000000000004)).toThrow(/2 decimal places/);
  });

  test('rejects junk input', () => {
    expect(() => rupeesToPaise('abc')).toThrow();
    expect(() => rupeesToPaise('')).toThrow();
    expect(() => rupeesToPaise(null)).toThrow();
    expect(() => rupeesToPaise(undefined)).toThrow();
    expect(() => rupeesToPaise('1,000')).toThrow();
  });

  test('rejects absurdly large amounts', () => {
    expect(() => rupeesToPaise('99999999999')).toThrow(/maximum/);
  });

  test('always returns an integer', () => {
    ['0.01', '7.77', '1234.56', '999999'].forEach((value) => {
      expect(Number.isInteger(rupeesToPaise(value))).toBe(true);
    });
  });
});

describe('paiseToRupees', () => {
  test('round-trips with rupeesToPaise', () => {
    ['0.01', '12.5', '149.99', '1000', '87654.32'].forEach((value) => {
      expect(paiseToRupees(rupeesToPaise(value))).toBe(Number(value));
    });
  });

  test('formats to two decimal places', () => {
    expect(paiseToRupees(1)).toBe(0.01);
    expect(paiseToRupees(1250)).toBe(12.5);
    expect(paiseToRupees(0)).toBe(0);
  });
});

describe('formatPaise', () => {
  test('renders Indian-grouped rupee strings', () => {
    expect(formatPaise(149550)).toContain('1,495.50');
    expect(formatPaise(100)).toContain('1.00');
  });
});

describe('splitPaise', () => {
  test('splits evenly when it divides cleanly', () => {
    expect(splitPaise(30000, 3)).toEqual([10000, 10000, 10000]);
  });

  test('distributes the remainder so shares sum EXACTLY to the total', () => {
    const shares = splitPaise(10000, 3); // ₹100 across 3 people
    expect(shares).toEqual([3334, 3333, 3333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  test('never loses or invents paise for any split', () => {
    for (let total = 1; total <= 200; total += 7) {
      for (let count = 1; count <= 9; count += 1) {
        const shares = splitPaise(total, count);
        expect(shares).toHaveLength(count);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
        expect(shares.every(Number.isInteger)).toBe(true);
      }
    }
  });

  test('rejects invalid inputs', () => {
    expect(() => splitPaise(0, 3)).toThrow();
    expect(() => splitPaise(100, 0)).toThrow();
    expect(() => splitPaise(100.5, 2)).toThrow();
  });
});

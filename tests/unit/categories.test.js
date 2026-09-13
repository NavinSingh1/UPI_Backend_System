const { inferCategory } = require('../../src/utils/categories');

describe('inferCategory', () => {
  test('transfers and refunds are always TRANSFER', () => {
    expect(inferCategory('TRANSFER')).toBe('TRANSFER');
    expect(inferCategory('REFUND')).toBe('TRANSFER');
  });

  test('wallet top-ups and withdrawals are OTHER', () => {
    expect(inferCategory('ADD_MONEY')).toBe('OTHER');
    expect(inferCategory('WITHDRAW')).toBe('OTHER');
  });

  test('recognizes billers by keyword, case-insensitively', () => {
    expect(inferCategory('BILL_PAY', 'Swiggy Order #123')).toBe('FOOD');
    expect(inferCategory('BILL_PAY', 'ZOMATO')).toBe('FOOD');
    expect(inferCategory('BILL_PAY', 'Uber ride')).toBe('TRAVEL');
    expect(inferCategory('BILL_PAY', 'Adani Electricity')).toBe('BILLS');
    expect(inferCategory('BILL_PAY', 'Jio Mobile Recharge')).toBe('RECHARGE');
    expect(inferCategory('BILL_PAY', 'Amazon India')).toBe('SHOPPING');
    expect(inferCategory('BILL_PAY', 'Netflix subscription')).toBe('ENTERTAINMENT');
  });

  test('an unrecognized named biller still counts as a bill', () => {
    expect(inferCategory('BILL_PAY', 'Local Kirana Store Co')).toBe('SHOPPING'); // matches "store"
    expect(inferCategory('BILL_PAY', 'Something Unknown Ltd')).toBe('BILLS');
  });

  test('a bill with no biller name falls back to OTHER', () => {
    expect(inferCategory('BILL_PAY')).toBe('OTHER');
    expect(inferCategory('BILL_PAY', '')).toBe('OTHER');
  });

  test('never returns a value outside the allowed set', () => {
    const allowed = ['TRANSFER', 'FOOD', 'TRAVEL', 'BILLS', 'SHOPPING', 'ENTERTAINMENT', 'RECHARGE', 'OTHER'];
    const samples = ['', 'random text', 'Swiggy', 'IRCTC', null, undefined];

    samples.forEach((biller) => {
      expect(allowed).toContain(inferCategory('BILL_PAY', biller));
    });
  });
});

const { buildEntries, assertBalanced, netForAccount } = require('../../src/services/ledgerEntries');

const A = '507f1f77bcf86cd799439011';
const B = '507f1f77bcf86cd799439012';

describe('buildEntries', () => {
  test('TRANSFER debits the sender and credits the receiver', () => {
    const entries = buildEntries({ type: 'TRANSFER', amountPaise: 5000, fromUserId: A, toUserId: B });

    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.direction === 'DEBIT').account).toBe(A);
    expect(entries.find((e) => e.direction === 'CREDIT').account).toBe(B);
    expect(assertBalanced(entries)).toBe(true);
  });

  test('ADD_MONEY credits the user against the external bank', () => {
    const entries = buildEntries({ type: 'ADD_MONEY', amountPaise: 25000, toUserId: B });

    const debit = entries.find((e) => e.direction === 'DEBIT');
    const credit = entries.find((e) => e.direction === 'CREDIT');

    expect(debit.account).toBeNull();
    expect(debit.externalAccount).toBe('BANK');
    expect(credit.account).toBe(B);
    expect(assertBalanced(entries)).toBe(true);
  });

  test('WITHDRAW debits the user and credits the external bank', () => {
    const entries = buildEntries({ type: 'WITHDRAW', amountPaise: 10000, fromUserId: A });

    expect(entries.find((e) => e.direction === 'DEBIT').account).toBe(A);
    expect(entries.find((e) => e.direction === 'CREDIT').externalAccount).toBe('BANK');
    expect(assertBalanced(entries)).toBe(true);
  });

  test('BILL_PAY debits the user and credits the biller', () => {
    const entries = buildEntries({ type: 'BILL_PAY', amountPaise: 79900, fromUserId: A });

    expect(entries.find((e) => e.direction === 'CREDIT').externalAccount).toBe('BILLER');
    expect(assertBalanced(entries)).toBe(true);
  });

  test('REFUND reverses the direction of a transfer', () => {
    const entries = buildEntries({ type: 'REFUND', amountPaise: 5000, fromUserId: B, toUserId: A });

    expect(entries.find((e) => e.direction === 'DEBIT').account).toBe(B);
    expect(entries.find((e) => e.direction === 'CREDIT').account).toBe(A);
    expect(assertBalanced(entries)).toBe(true);
  });

  test('every type produces a balanced pair', () => {
    const cases = [
      { type: 'TRANSFER', fromUserId: A, toUserId: B },
      { type: 'REFUND', fromUserId: B, toUserId: A },
      { type: 'ADD_MONEY', toUserId: A },
      { type: 'WITHDRAW', fromUserId: A },
      { type: 'BILL_PAY', fromUserId: A },
    ];

    cases.forEach((base) => {
      const entries = buildEntries({ ...base, amountPaise: 12345 });
      expect(entries).toHaveLength(2);
      expect(assertBalanced(entries)).toBe(true);
    });
  });

  test('rejects missing counterparties and bad amounts', () => {
    expect(() => buildEntries({ type: 'TRANSFER', amountPaise: 100, fromUserId: A })).toThrow(/toUserId/);
    expect(() => buildEntries({ type: 'WITHDRAW', amountPaise: 100 })).toThrow(/fromUserId/);
    expect(() => buildEntries({ type: 'NONSENSE', amountPaise: 100, fromUserId: A })).toThrow(/Unknown/);
    expect(() => buildEntries({ type: 'TRANSFER', amountPaise: 0, fromUserId: A, toUserId: B })).toThrow();
    expect(() => buildEntries({ type: 'TRANSFER', amountPaise: 10.5, fromUserId: A, toUserId: B })).toThrow();
  });
});

describe('assertBalanced', () => {
  test('throws when debits and credits disagree', () => {
    const unbalanced = [
      { account: A, direction: 'DEBIT', amountPaise: 5000 },
      { account: B, direction: 'CREDIT', amountPaise: 4999 },
    ];
    expect(() => assertBalanced(unbalanced)).toThrow(/imbalance/);
  });

  test('throws when there are too few entries', () => {
    expect(() => assertBalanced([{ account: A, direction: 'DEBIT', amountPaise: 1 }])).toThrow();
  });

  test('accepts a balanced multi-entry set', () => {
    const entries = [
      { account: A, direction: 'DEBIT', amountPaise: 3000 },
      { account: B, direction: 'CREDIT', amountPaise: 1000 },
      { account: null, direction: 'CREDIT', amountPaise: 2000 },
    ];
    expect(assertBalanced(entries)).toBe(true);
  });
});

describe('netForAccount', () => {
  test('nets credits against debits for one account', () => {
    const entries = [
      { account: A, direction: 'DEBIT', amountPaise: 5000 },
      { account: A, direction: 'CREDIT', amountPaise: 2000 },
      { account: B, direction: 'CREDIT', amountPaise: 3000 },
    ];

    expect(netForAccount(entries, A)).toBe(-3000);
    expect(netForAccount(entries, B)).toBe(3000);
  });

  test('ignores external (null) accounts', () => {
    const entries = [
      { account: null, externalAccount: 'BANK', direction: 'DEBIT', amountPaise: 5000 },
      { account: A, direction: 'CREDIT', amountPaise: 5000 },
    ];
    expect(netForAccount(entries, A)).toBe(5000);
  });
});

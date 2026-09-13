const { buildStatementCsv, csvCell, directionFor, counterpartyFor } = require('../../src/services/statementService');

const USER = '507f1f77bcf86cd799439011';
const OTHER = '507f1f77bcf86cd799439012';

const txn = (overrides) => ({
  _id: '507f1f77bcf86cd7994390aa',
  createdAt: new Date('2026-09-09T10:00:00Z'),
  type: 'TRANSFER',
  category: 'TRANSFER',
  amountPaise: 25050,
  status: 'SUCCESS',
  sender: { _id: USER, name: 'Me', upiId: 'me@phonepe' },
  receiver: { _id: OTHER, name: 'Them', upiId: 'them@phonepe' },
  ...overrides,
});

describe('csvCell', () => {
  test('leaves plain values alone', () => {
    expect(csvCell('hello')).toBe('hello');
    expect(csvCell(42)).toBe('42');
  });

  test('quotes and escapes values containing commas, quotes or newlines', () => {
    expect(csvCell('Adani, Electricity')).toBe('"Adani, Electricity"');
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  test('renders null/undefined as empty', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});

describe('directionFor', () => {
  test('outgoing transfer is a debit for the sender', () => {
    expect(directionFor(txn(), USER)).toBe('DEBIT');
  });

  test('the same transfer is a credit for the receiver', () => {
    expect(directionFor(txn(), OTHER)).toBe('CREDIT');
  });

  test('top-ups credit, withdrawals and bills debit', () => {
    expect(directionFor(txn({ type: 'ADD_MONEY', receiver: { _id: USER } }), USER)).toBe('CREDIT');
    expect(directionFor(txn({ type: 'WITHDRAW' }), USER)).toBe('DEBIT');
    expect(directionFor(txn({ type: 'BILL_PAY' }), USER)).toBe('DEBIT');
  });
});

describe('counterpartyFor', () => {
  test('names the other party on a transfer', () => {
    expect(counterpartyFor(txn(), USER)).toContain('Them');
  });

  test('uses the biller name for bills and the bank for top-ups', () => {
    expect(counterpartyFor(txn({ type: 'BILL_PAY', billerName: 'Jio' }), USER)).toBe('Jio');
    expect(counterpartyFor(txn({ type: 'ADD_MONEY' }), USER)).toBe('Linked Bank');
    expect(counterpartyFor(txn({ type: 'WITHDRAW' }), USER)).toBe('Linked Bank');
  });
});

describe('buildStatementCsv', () => {
  test('emits a header row plus one row per transaction', () => {
    const csv = buildStatementCsv([txn(), txn({ type: 'BILL_PAY', billerName: 'Jio' })], USER);
    const lines = csv.split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Date,Transaction ID,Type');
  });

  test('writes amounts as rupees with 2dp, not paise', () => {
    const csv = buildStatementCsv([txn({ amountPaise: 25050 })], USER);
    expect(csv).toContain('250.50');
    expect(csv).not.toContain('25050');
  });

  test('escapes biller names containing commas', () => {
    const csv = buildStatementCsv([txn({ type: 'BILL_PAY', billerName: 'Adani, Electricity' })], USER);
    expect(csv).toContain('"Adani, Electricity"');
  });

  test('handles an empty period', () => {
    const csv = buildStatementCsv([], USER);
    expect(csv.split('\n')).toHaveLength(1); // header only
  });
});

const { buildUpiUri, parseUpiUri } = require('../../src/utils/upi');

describe('buildUpiUri', () => {
  test('builds a upi://pay deep link', () => {
    const uri = buildUpiUri({ upiId: 'amit123@phonepe', name: 'Amit Sharma' });

    expect(uri.startsWith('upi://pay?')).toBe(true);
    expect(uri).toContain('pa=amit123%40phonepe');
    expect(uri).toContain('cu=INR');
  });

  test('includes a pre-filled amount in rupees with 2dp', () => {
    const uri = buildUpiUri({ upiId: 'a@phonepe', amountPaise: 125050 });
    expect(uri).toContain('am=1250.50');
  });

  test('omits the amount when not given', () => {
    expect(buildUpiUri({ upiId: 'a@phonepe' })).not.toContain('am=');
  });

  test('requires a upiId', () => {
    expect(() => buildUpiUri({})).toThrow(/upiId/);
  });
});

describe('parseUpiUri', () => {
  test('round-trips a built URI', () => {
    const uri = buildUpiUri({
      upiId: 'priya456@phonepe',
      name: 'Priya Singh',
      amountPaise: 49900,
      note: 'Dinner',
    });

    expect(parseUpiUri(uri)).toEqual({
      upiId: 'priya456@phonepe',
      name: 'Priya Singh',
      amountPaise: 49900,
      note: 'Dinner',
    });
  });

  test('accepts a bare UPI ID', () => {
    expect(parseUpiUri('rahul789@phonepe')).toEqual({ upiId: 'rahul789@phonepe' });
  });

  test('rejects a link with no payee address', () => {
    expect(() => parseUpiUri('upi://pay?am=100&cu=INR')).toThrow(/payee address/);
  });

  test('rejects nonsense', () => {
    expect(() => parseUpiUri('https://example.com')).toThrow();
    expect(() => parseUpiUri('not a upi id')).toThrow();
  });
});

const CATEGORY_KEYWORDS = {
  FOOD: ['swiggy', 'zomato', 'dominos', 'restaurant', 'cafe', 'food', 'blinkit', 'zepto', 'bigbasket'],
  TRAVEL: ['uber', 'ola', 'rapido', 'irctc', 'indigo', 'railway', 'metro', 'petrol', 'fuel', 'flight'],
  BILLS: ['electricity', 'adani', 'tata power', 'cesc', 'gas', 'water', 'broadband', 'wifi', 'insurance', 'rent'],
  RECHARGE: ['jio', 'airtel', 'vodafone', 'vi prepaid', 'bsnl', 'recharge', 'dth', 'tata sky'],
  SHOPPING: ['amazon', 'flipkart', 'myntra', 'ajio', 'nykaa', 'meesho', 'store', 'mart'],
  ENTERTAINMENT: ['netflix', 'spotify', 'hotstar', 'prime video', 'bookmyshow', 'pvr', 'inox', 'gaming'],
};

/**
 * Best-effort category for a transaction, used to power spending analytics.
 * Pure function (no DB) so it's cheap to unit-test — see tests/unit.
 * Users can always override the guess via PATCH /transactions/:txnId/category.
 */
const inferCategory = (type, billerName = '') => {
  if (type === 'TRANSFER' || type === 'REFUND') return 'TRANSFER';
  if (type === 'ADD_MONEY' || type === 'WITHDRAW') return 'OTHER';

  const haystack = String(billerName || '').toLowerCase();
  if (!haystack) return 'OTHER';

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((keyword) => haystack.includes(keyword))) return category;
  }

  return 'BILLS'; // a named biller we don't recognize is still a bill
};

module.exports = { inferCategory, CATEGORY_KEYWORDS };

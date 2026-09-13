const PDFDocument = require('pdfkit');
const { paiseToRupees, formatPaise } = require('../utils/money');

/** Escapes a value for CSV (quotes, commas, newlines). */
const csvCell = (value) => {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

/** Which way the money moved from this user's perspective. */
const directionFor = (txn, userId) => {
  const isSender = txn.sender && String(txn.sender._id || txn.sender) === String(userId);
  if (txn.type === 'ADD_MONEY') return 'CREDIT';
  if (txn.type === 'WITHDRAW' || txn.type === 'BILL_PAY') return 'DEBIT';
  return isSender ? 'DEBIT' : 'CREDIT';
};

const counterpartyFor = (txn, userId) => {
  const isSender = txn.sender && String(txn.sender._id || txn.sender) === String(userId);
  if (txn.type === 'BILL_PAY') return txn.billerName || 'Biller';
  if (txn.type === 'ADD_MONEY') return 'Linked Bank';
  if (txn.type === 'WITHDRAW') return 'Linked Bank';
  const other = isSender ? txn.receiver : txn.sender;
  if (!other) return '—';
  return other.name ? `${other.name} (${other.upiId || ''})`.trim() : String(other);
};

const STATEMENT_COLUMNS = ['Date', 'Transaction ID', 'Type', 'Category', 'Counterparty', 'Direction', 'Amount (INR)', 'Status'];

const buildStatementCsv = (transactions, userId) => {
  const rows = transactions.map((txn) => [
    new Date(txn.createdAt).toISOString(),
    String(txn._id),
    txn.type,
    txn.category || 'OTHER',
    counterpartyFor(txn, userId),
    directionFor(txn, userId),
    paiseToRupees(txn.amountPaise).toFixed(2),
    txn.status,
  ]);

  return [STATEMENT_COLUMNS, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
};

/**
 * Streams a PDF statement straight to the response — nothing is buffered in
 * memory or written to disk.
 */
const buildStatementPdf = ({ transactions, userId, user, from, to, stream }) => {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(stream);

  doc.fontSize(18).text('PhonePe Clone — Account Statement', { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#555');
  doc.text(`${user.name}  •  ${user.upiId || ''}`);
  doc.text(`Period: ${new Date(from).toDateString()} to ${new Date(to).toDateString()}`);
  doc.text(`Generated: ${new Date().toLocaleString('en-IN')}`);
  doc.moveDown(0.8);

  let creditPaise = 0;
  let debitPaise = 0;
  transactions.forEach((txn) => {
    if (directionFor(txn, userId) === 'CREDIT') creditPaise += txn.amountPaise;
    else debitPaise += txn.amountPaise;
  });

  doc.fillColor('#000').fontSize(11);
  doc.text(`Total credited: ${formatPaise(creditPaise)}    Total debited: ${formatPaise(debitPaise)}    Net: ${formatPaise(creditPaise - debitPaise)}`);
  doc.moveDown(0.8);

  // Simple fixed-width table
  const columnX = [40, 130, 195, 260, 400, 470];
  const header = ['Date', 'Type', 'Category', 'Counterparty', 'Amount', 'Dir'];

  const drawRow = (values, options = {}) => {
    const y = doc.y;
    doc.fontSize(options.bold ? 9.5 : 9).fillColor(options.bold ? '#000' : '#333');
    values.forEach((value, i) => {
      doc.text(String(value), columnX[i], y, {
        width: (columnX[i + 1] || 555) - columnX[i] - 6,
        ellipsis: true,
      });
    });
    doc.y = y + (options.bold ? 16 : 14);
  };

  drawRow(header, { bold: true });
  doc.moveTo(40, doc.y - 3).lineTo(555, doc.y - 3).strokeColor('#ccc').stroke();

  if (!transactions.length) {
    doc.moveDown(1).fontSize(10).fillColor('#777').text('No transactions in this period.', 40);
  }

  transactions.forEach((txn) => {
    if (doc.y > 760) {
      doc.addPage();
      drawRow(header, { bold: true });
    }
    drawRow([
      new Date(txn.createdAt).toLocaleDateString('en-IN'),
      txn.type,
      txn.category || 'OTHER',
      counterpartyFor(txn, userId),
      paiseToRupees(txn.amountPaise).toFixed(2),
      directionFor(txn, userId) === 'CREDIT' ? 'CR' : 'DR',
    ]);
  });

  doc.end();
  return doc;
};

module.exports = { buildStatementCsv, buildStatementPdf, directionFor, counterpartyFor, csvCell };

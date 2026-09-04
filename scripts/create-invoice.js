import 'dotenv/config';
import crypto from 'node:crypto';
import { openDatabase } from '../db.js';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const clientName = argument('client');
const email = argument('email');
const amountText = argument('amount');
const currency = (argument('currency') || 'usd').toLowerCase();
const dueDate = argument('due');
const invoiceNumber = (argument('invoice') || `INV${crypto.randomBytes(8).toString('hex').toUpperCase()}`).toUpperCase();
const amount = Math.round(Number(amountText) * 100);

if (!clientName || !email || !dueDate || !Number.isSafeInteger(amount) || amount <= 0 || !/^[a-z]{3}$/.test(currency)) {
  console.error('Usage: npm run create-invoice -- --client "Client Name" --email billing@example.com --amount 2500.00 --currency usd --due 2026-09-30 [--invoice INVABC12345]');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
  console.error('Due date must use YYYY-MM-DD.');
  process.exit(1);
}

const db = openDatabase();
try {
  db.prepare(`
    INSERT INTO invoices (invoice_number, client_name, email, amount, currency, due_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(invoiceNumber, clientName.trim(), email.trim().toLowerCase(), amount, currency, dueDate);
  console.log(`Created invoice ${invoiceNumber}`);
} finally {
  db.close();
}

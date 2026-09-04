import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { createInvoiceRepository } from '../db.js';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.prepare(`INSERT INTO invoices
    (invoice_number, client_name, email, amount, currency, due_date)
    VALUES ('INVABC12345', 'Example Client', 'billing@example.com', 250000, 'usd', '2026-09-30')`).run();
  return { db, repo: createInvoiceRepository(db) };
}

test('completed checkout marks an invoice paid once', () => {
  const { db, repo } = fixture();
  const event = { id: 'evt_1', type: 'checkout.session.completed', created: 1788134400 };
  const session = {
    id: 'cs_live_12345678901234567890',
    payment_status: 'paid',
    amount_total: 250000,
    currency: 'usd',
    payment_intent: 'pi_123',
    metadata: { invoice_number: 'INVABC12345' }
  };
  assert.equal(repo.completeCheckout(event, session).paid, true);
  assert.equal(repo.findFull('INVABC12345').status, 'paid');
  assert.equal(repo.completeCheckout(event, session).duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM webhook_events').get().count, 1);
  db.close();
});

test('amount mismatch never marks an invoice paid', () => {
  const { db, repo } = fixture();
  const result = repo.completeCheckout(
    { id: 'evt_2', type: 'checkout.session.completed', created: 1788134400 },
    { id: 'cs_live_2', payment_status: 'paid', amount_total: 1, currency: 'usd', payment_intent: 'pi_2', metadata: { invoice_number: 'INVABC12345' } }
  );
  assert.equal(result.rejected, true);
  assert.equal(repo.findFull('INVABC12345').status, 'pending');
  db.close();
});

test('failed payment is recorded from payment intent metadata', () => {
  const { db, repo } = fixture();
  const result = repo.recordFailure(
    { id: 'evt_3', type: 'payment_intent.payment_failed' },
    { id: 'pi_failed', metadata: { invoice_number: 'INVABC12345' } }
  );
  assert.equal(result.failed, true);
  assert.equal(repo.findFull('INVABC12345').status, 'failed');
  assert.equal(repo.recordFailure(
    { id: 'evt_3', type: 'payment_intent.payment_failed' },
    { id: 'pi_failed', metadata: { invoice_number: 'INVABC12345' } }
  ).duplicate, true);
  db.close();
});

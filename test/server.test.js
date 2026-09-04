import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server.js';

function startFixture(overrides = {}) {
  const invoice = {
    id: 1,
    invoice_number: 'INVABC12345',
    client_name: 'Example Client',
    email: 'billing@example.com',
    amount: 250000,
    currency: 'usd',
    due_date: '2026-09-30',
    status: 'pending'
  };
  const invoices = {
    findPublic: number => number === invoice.invoice_number ? invoice : undefined,
    findFull: number => number === invoice.invoice_number ? invoice : undefined,
    findStatusBySession: () => ({ status: 'pending' }),
    findPaymentBySession: () => undefined,
    getPaidTotal: () => 0,
    acquireCheckoutLock: () => true,
    releaseCheckoutLock: () => {},
    saveCheckout: () => {},
    completeCheckout: () => ({ paid: true }),
    recordFailure: () => ({ failed: true }),
    ...overrides.invoices
  };
  let checkoutPayload;
  const stripeClient = {
    checkout: {
      sessions: {
        create: async payload => {
          checkoutPayload = payload;
          return { id: 'cs_live_12345678901234567890', url: 'https://checkout.stripe.com/example', expires_at: 1788136200 };
        }
      }
    },
    webhooks: { constructEvent: () => { throw new Error('not used'); } }
  };
  const app = createApp({
    stripeClient,
    invoices,
    env: { PUBLIC_BASE_URL: 'https://payments.example.com', STRIPE_WEBHOOK_SECRET: 'whsec_example' },
    logger: { info() {}, warn() {}, error() {} }
  });
  const server = app.listen(0);
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    getCheckoutPayload: () => checkoutPayload
  };
}

test('invoice lookup returns database amount and omits email', async t => {
  const fixture = startFixture();
  t.after(() => fixture.server.close());
  const response = await fetch(`${fixture.baseUrl}/api/invoices/INVABC12345`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.amount, 250000);
  assert.equal(Object.hasOwn(body, 'email'), false);
});

test('hyphenated invoice references pass validation', async t => {
  const fixture = startFixture();
  t.after(() => fixture.server.close());
  const response = await fetch(`${fixture.baseUrl}/api/invoices/INV-2026-001`);
  assert.equal(response.status, 404);
});

test('checkout uses the invoice amount and metadata', async t => {
  const fixture = startFixture();
  t.after(() => fixture.server.close());
  const response = await fetch(`${fixture.baseUrl}/api/create-checkout-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invoiceNumber: 'INVABC12345', paymentAmount: '500.00', amount: 1 })
  });
  assert.equal(response.status, 201);
  const payload = fixture.getCheckoutPayload();
  assert.equal(payload.line_items[0].price_data.unit_amount, 50000);
  assert.equal(payload.metadata.invoice_number, 'INVABC12345');
});

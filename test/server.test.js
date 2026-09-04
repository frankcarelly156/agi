import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server.js';

function startFixture() {
  const checkoutCalls = [];
  const stripeClient = {
    checkout: {
      sessions: {
        create: async (payload, options) => {
          checkoutCalls.push({ payload, options });
          return { id: 'cs_live_12345678901234567890', url: 'https://checkout.stripe.com/example', expires_at: 1788136200 };
        }
      }
    },
    webhooks: { constructEvent: () => { throw new Error('not used'); } }
  };
  const app = createApp({
    stripeClient,
    env: { PUBLIC_BASE_URL: 'https://payments.example.com', STRIPE_WEBHOOK_SECRET: 'whsec_example' },
    logger: { info() {}, warn() {}, error() {} }
  });
  const server = app.listen(0);
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    getCheckoutPayload: () => checkoutCalls.at(-1)?.payload,
    getCheckoutCalls: () => checkoutCalls
  };
}

test('stateless invoice lookup returns the configured public amount', async t => {
  const fixture = startFixture();
  t.after(() => fixture.server.close());
  const response = await fetch(`${fixture.baseUrl}/api/invoices/INV2026001`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.amount, 500000);
  assert.equal(Object.hasOwn(body, 'email'), false);
});

test('hyphenated invoice references resolve to the stateless invoice', async t => {
  const fixture = startFixture();
  t.after(() => fixture.server.close());
  const response = await fetch(`${fixture.baseUrl}/api/invoices/INV-2026-001`);
  assert.equal(response.status, 200);
});

test('checkout accepts only a server-validated payment amount', async t => {
  const fixture = startFixture();
  t.after(() => fixture.server.close());
  const response = await fetch(`${fixture.baseUrl}/api/create-checkout-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invoiceNumber: 'INV2026001', paymentAmount: '500.00', amount: 1 })
  });
  assert.equal(response.status, 201);
  const payload = fixture.getCheckoutPayload();
  assert.equal(payload.line_items[0].price_data.unit_amount, 50000);
  assert.equal(payload.metadata.invoice_number, 'INV2026001');
});

test('checkout rejects payment amounts outside the permitted range', async t => {
  const fixture = startFixture();
  t.after(() => fixture.server.close());
  const response = await fetch(`${fixture.baseUrl}/api/create-checkout-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invoiceNumber: 'INV2026001', paymentAmount: '499.99' })
  });
  assert.equal(response.status, 400);
});

test('repeat checkout requests reuse identical idempotency parameters', async t => {
  const fixture = startFixture();
  t.after(() => fixture.server.close());
  const request = () => fetch(`${fixture.baseUrl}/api/create-checkout-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invoiceNumber: 'INV2026001', paymentAmount: '500.00' })
  });
  const [first, second] = await Promise.all([request(), request()]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const [firstCall, secondCall] = fixture.getCheckoutCalls();
  assert.equal(firstCall.options.idempotencyKey, secondCall.options.idempotencyKey);
  assert.equal(firstCall.payload.expires_at, secondCall.payload.expires_at);
});

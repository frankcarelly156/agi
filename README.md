# Invoice Payment Portal

A stateless Express payment portal that creates Stripe-hosted Checkout sessions for the configured A&J Management invoice experience. It does not use a database or retain invoice or payment records.

## Requirements

- Node.js 22 or newer
- HTTPS in production
- A Stripe account with Checkout enabled

## Setup

1. Run `npm install`.
2. Configure `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `PUBLIC_BASE_URL` in your hosting provider's secrets vault.
3. Start the service with `npm start`.

The portal accepts payments from $500.00 to $5,000.00 USD for `INV2026001` (or its hyphenated equivalent). Checkout validates the amount server-side before creating a session.

## Stripe webhook

Configure a webhook endpoint at:

```text
https://payments.example.com/webhook
```

Subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `payment_intent.payment_failed`

The webhook signature is verified before the event is accepted. Because the portal is stateless, it logs verified webhook events but does not save payment status or balances.

## Railway

No Railway Volume is required. Set the secrets above, use the supplied Dockerfile, and configure `PUBLIC_BASE_URL` to the deployed HTTPS origin.

## Verification

```bash
npm run check
npm test
```

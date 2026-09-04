# Invoice Payment Portal

A production-oriented Express and SQLite invoice portal using Stripe-hosted Checkout. Invoice amounts are always read from the database. The success redirect never changes payment state; only a signature-verified Stripe webhook can mark an invoice paid.

## Requirements

- Node.js 22 or newer
- A persistent disk for the SQLite database
- HTTPS in production
- A Stripe account with Checkout enabled

## Setup

1. Run `npm install`.
2. Copy `.env.example` to `.env`.
3. Store Stripe credentials in the hosting provider's secrets vault. Prefer a restricted key with only the permissions this service needs. Never commit live keys.
4. Set `PUBLIC_BASE_URL` to the final HTTPS origin.
5. Start the service with `npm start`.

Create an invoice:

```bash
npm run create-invoice -- --client "Example Client" --email billing@example.com --amount 2500.00 --currency usd --due 2026-09-30
```

The command returns a random, high-entropy invoice number. Send that invoice number only to the intended client because it acts as the lookup credential.

## Stripe webhook

Create a Stripe webhook endpoint pointing to:

```text
https://payments.example.com/webhook
```

Subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `payment_intent.payment_failed`

Save its signing secret as `STRIPE_WEBHOOK_SECRET`. Configure production secrets in a secrets vault and use separate keys for development and production.

For local testing:

```bash
stripe listen --forward-to localhost:4242/webhook
```

## Production notes

- Deploy to a Node.js host with a persistent volume. SQLite is not suitable for horizontally scaled replicas sharing no disk; use PostgreSQL before scaling beyond one application instance.
- A production Dockerfile is included. Mount persistent storage at `/app/data`.
- Back up the database and test restores.
- Terminate TLS at the platform or reverse proxy.
- Set `TRUST_PROXY=1` only when exactly one trusted proxy sits in front of Express; adjust it to your topology.
- Allowlist Stripe webhook IP ranges at the network edge when your hosting provider supports it.
- Configure Stripe payment methods in the Dashboard. The application intentionally does not hardcode card-only payment methods.
- The webhook transaction records each Stripe event ID uniquely, validates payment status, amount, and currency, and updates the invoice atomically.
- Add your own email provider if confirmation emails are required. The current success page states that confirmation will be sent, but this package does not send email by itself.

## Verification

```bash
npm run check
npm test
```

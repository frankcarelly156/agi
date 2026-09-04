import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import Stripe from 'stripe';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Public invoice references are deliberately constrained, while allowing the
// common hyphenated format (for example, INV-2026-001).
const invoicePattern = /^[A-Z0-9](?:[A-Z0-9-]{0,62}[A-Z0-9])?$/;
const sessionPattern = /^cs_(?:test_|live_)?[A-Za-z0-9]{20,}$/;
const minimumPayment = 50_000;
const maximumPayment = 500_000;
const statelessInvoiceNumber = 'INV2026001';

function parsePaymentAmount(value) {
  const text = String(value || '').trim();
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function required(name, env) {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function safeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error('PUBLIC_BASE_URL must use HTTPS outside localhost');
  }
  return url.origin;
}

export function createApp({ stripeClient, invoices, env = process.env, logger = console }) {
  const app = express();
  const baseUrl = safeBaseUrl(required('PUBLIC_BASE_URL', env));
  const webhookSecret = required('STRIPE_WEBHOOK_SECRET', env);
  const integrationIdentifier = env.STRIPE_INTEGRATION_IDENTIFIER ||
    'invoiceportal';

  if (env.TRUST_PROXY) app.set('trust proxy', Number(env.TRUST_PROXY));
  app.disable('x-powered-by');

  app.post('/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    let event;
    try {
      event = stripeClient.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        webhookSecret
      );
    } catch (error) {
      logger.warn('stripe_webhook_signature_failed', { message: error.message });
      return res.status(400).send('Invalid webhook signature');
    }

    try {
      if (!invoices) {
        logger.info('stripe_webhook_received', { eventId: event.id, type: event.type });
        return res.sendStatus(200);
      }
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        const result = invoices.completeCheckout(event, event.data.object);
        logger.info('stripe_checkout_completed', { eventId: event.id, result });
      } else if (event.type === 'payment_intent.payment_failed') {
        const result = invoices.recordFailure(event, event.data.object);
        logger.warn('stripe_payment_failed', { eventId: event.id, paymentIntent: event.data.object.id, result });
      }
      return res.sendStatus(200);
    } catch (error) {
      logger.error('stripe_webhook_processing_failed', { eventId: event.id, message: error.message });
      return res.sendStatus(500);
    }
  });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'", 'https://checkout.stripe.com']
      }
    },
    referrerPolicy: { policy: 'no-referrer' }
  }));
  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: env.NODE_ENV === 'production' ? '1h' : 0 }));

  const lookupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false });
  const checkoutLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });

  app.get('/api/locale', (req, res) => {
    const configuredRegionHeader = env.GEOIP_REGION_HEADER?.toLowerCase();
    const region = configuredRegionHeader && env.TRUST_PROXY
      ? String(req.headers[configuredRegionHeader] || '').toUpperCase()
      : '';
    const preferredLanguage = String(req.headers['accept-language'] || '').toLowerCase();
    const locale = region === 'QC' || /(^|,)\s*fr(?:[-_]ca)?\b/.test(preferredLanguage) ? 'fr-CA' : 'en';
    res.set('Vary', 'Accept-Language').json({ locale });
  });

  app.get('/api/invoices/:invoiceNumber', lookupLimiter, (req, res) => {
    const invoiceNumber = req.params.invoiceNumber.trim().toUpperCase();
    if (!invoicePattern.test(invoiceNumber)) return res.status(400).json({ error: 'Invalid invoice number' });
    if (!invoices) {
      if (invoiceNumber.replaceAll('-', '') !== statelessInvoiceNumber) return res.status(404).json({ error: 'Invoice not found' });
      return res.json({
        invoice_number: statelessInvoiceNumber,
        amount: maximumPayment,
        currency: 'usd',
        status: 'pending'
      });
    }
    const invoice = invoices.findPublic(invoiceNumber);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    return res.json({
      invoice_number: invoice.invoice_number,
      client_name: invoice.client_name,
      amount: invoice.amount,
      currency: invoice.currency,
      due_date: invoice.due_date,
      status: invoice.status
    });
  });

  app.post('/api/create-checkout-session', checkoutLimiter, async (req, res) => {
    const invoiceNumber = String(req.body?.invoiceNumber || '').trim().toUpperCase();
    if (!invoicePattern.test(invoiceNumber)) return res.status(400).json({ error: 'Invalid invoice number' });
    const paymentAmount = parsePaymentAmount(req.body?.paymentAmount);
    if (paymentAmount === null || paymentAmount < minimumPayment || paymentAmount > maximumPayment) {
      return res.status(400).json({ error: 'Payment amount must be between $500.00 and $5,000.00' });
    }
    const normalizedInvoiceNumber = invoiceNumber.replaceAll('-', '');
    if (!invoices && normalizedInvoiceNumber !== statelessInvoiceNumber) return res.status(404).json({ error: 'Invoice not found' });
    const invoice = invoices?.findFull(invoiceNumber);
    if (invoices && !invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice?.status === 'paid') return res.status(409).json({ error: 'Invoice is already paid' });
    const remainingBalance = invoice ? invoice.amount - invoices.getPaidTotal(invoice.id) : maximumPayment;
    if (paymentAmount > remainingBalance) return res.status(409).json({ error: 'Payment amount exceeds the remaining balance' });
    if (invoice && !invoices.acquireCheckoutLock(invoiceNumber)) return res.status(409).json({ error: 'Checkout is already being prepared. Please retry shortly.' });

    try {
      const checkoutWindowSeconds = 30 * 60;
      const checkoutWindow = Math.floor(Date.now() / 1000 / checkoutWindowSeconds);
      // This remains identical for retries in the same window while always
      // satisfying Stripe's requirement of at least 30 minutes until expiry.
      const expiresAt = (checkoutWindow + 2) * checkoutWindowSeconds;
      const session = await stripeClient.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: invoice?.currency || 'usd',
            product_data: { name: `A&J Management invoice ${statelessInvoiceNumber}` },
            unit_amount: paymentAmount
          },
          quantity: 1
        }],
        metadata: { invoice_number: invoice?.invoice_number || statelessInvoiceNumber },
        payment_intent_data: { metadata: { invoice_number: invoice?.invoice_number || statelessInvoiceNumber } },
        success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/?invoice=${statelessInvoiceNumber}`,
        expires_at: expiresAt,
        integration_identifier: integrationIdentifier
      }, {
        idempotencyKey: `invoice-checkout-v3-${invoice?.id || statelessInvoiceNumber}-${paymentAmount}-${checkoutWindow}`
      });
      if (invoice) {
        invoices.saveCheckout({
          invoiceNumber,
          sessionId: session.id,
          url: session.url,
          expiresAt: session.expires_at
        });
      }
      return res.status(201).json({ url: session.url });
    } catch (error) {
      if (invoice) invoices.releaseCheckoutLock(invoiceNumber);
      logger.error('checkout_session_creation_failed', { invoiceNumber, type: error.type, code: error.code, message: error.message });
      return res.status(502).json({ error: 'Unable to start payment. Please try again.' });
    }
  });

  app.get('/api/payment-status', lookupLimiter, (req, res) => {
    const sessionId = String(req.query.session_id || '');
    if (!sessionPattern.test(sessionId)) return res.status(400).json({ error: 'Invalid session identifier' });
    if (!invoices) return res.status(404).json({ error: 'Payment status is not stored' });
    const invoice = invoices.findStatusBySession(sessionId);
    if (!invoice) return res.status(404).json({ error: 'Payment not found' });
    const payment = invoices.findPaymentBySession(sessionId);
    if (payment && invoice.status !== 'paid') {
      return res.json({
        status: 'partial',
        remaining: Math.max(0, invoice.amount - invoices.getPaidTotal(invoice.id))
      });
    }
    return res.json({ status: invoice.status });
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

export function startServer(env = process.env) {
  const stripeKey = required('STRIPE_SECRET_KEY', env);
  if (env.NODE_ENV === 'production' && !/^[sr]k_live_/.test(stripeKey)) {
    throw new Error('Production requires a live restricted or secret Stripe key');
  }
  const stripeClient = new Stripe(stripeKey, {
    apiVersion: '2026-07-29.dahlia',
    maxNetworkRetries: 2,
    timeout: 20_000
  });
  const app = createApp({ stripeClient, env });
  const port = Number(env.PORT || 4242);
  const server = app.listen(port, () => console.log(`Invoice portal listening on port ${port}`));
  const shutdown = signal => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startServer();

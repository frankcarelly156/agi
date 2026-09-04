import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import Stripe from 'stripe';
import { createInvoiceRepository, openDatabase } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const invoicePattern = /^[A-Z0-9][A-Z0-9]{7,63}$/;
const sessionPattern = /^cs_(?:test_|live_)?[A-Za-z0-9]{20,}$/;

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
    `invoiceportal${crypto.randomBytes(6).toString('hex').slice(0, 8)}`;

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

  app.get('/api/invoices/:invoiceNumber', lookupLimiter, (req, res) => {
    const invoiceNumber = req.params.invoiceNumber.trim().toUpperCase();
    if (!invoicePattern.test(invoiceNumber)) return res.status(400).json({ error: 'Invalid invoice number' });
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
    const invoice = invoices.findFull(invoiceNumber);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid') return res.status(409).json({ error: 'Invoice is already paid' });
    if (!invoices.acquireCheckoutLock(invoiceNumber)) return res.status(409).json({ error: 'Checkout is already being prepared. Please retry shortly.' });

    try {
      const session = await stripeClient.checkout.sessions.create({
        mode: 'payment',
        customer_email: invoice.email,
        line_items: [{
          price_data: {
            currency: invoice.currency,
            product_data: { name: `Invoice ${invoice.invoice_number}` },
            unit_amount: invoice.amount
          },
          quantity: 1
        }],
        metadata: { invoice_number: invoice.invoice_number },
        payment_intent_data: { metadata: { invoice_number: invoice.invoice_number } },
        success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/?invoice=${encodeURIComponent(invoice.invoice_number)}`,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        integration_identifier: integrationIdentifier
      }, {
        idempotencyKey: `invoice-checkout-${invoice.id}-${Math.floor(Date.now() / (30 * 60 * 1000))}`
      });
      invoices.saveCheckout({
        invoiceNumber,
        sessionId: session.id,
        url: session.url,
        expiresAt: session.expires_at
      });
      return res.status(201).json({ url: session.url });
    } catch (error) {
      invoices.releaseCheckoutLock(invoiceNumber);
      logger.error('checkout_session_creation_failed', { invoiceNumber, type: error.type, code: error.code });
      return res.status(502).json({ error: 'Unable to start payment. Please try again.' });
    }
  });

  app.get('/api/payment-status', lookupLimiter, (req, res) => {
    const sessionId = String(req.query.session_id || '');
    if (!sessionPattern.test(sessionId)) return res.status(400).json({ error: 'Invalid session identifier' });
    const invoice = invoices.findStatusBySession(sessionId);
    if (!invoice) return res.status(404).json({ error: 'Payment not found' });
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
  const db = openDatabase(env.DATABASE_PATH);
  const invoices = createInvoiceRepository(db);
  const app = createApp({ stripeClient, invoices, env });
  const port = Number(env.PORT || 4242);
  const server = app.listen(port, () => console.log(`Invoice portal listening on port ${port}`));
  const shutdown = signal => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startServer();

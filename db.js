import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function openDatabase(filename = process.env.DATABASE_PATH || './data/invoices.sqlite') {
  const resolved = path.resolve(filename);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return db;
}

export function createInvoiceRepository(db) {
  const findPublic = db.prepare(`
    SELECT invoice_number, client_name, amount, currency, due_date, status
    FROM invoices WHERE invoice_number = ?
  `);
  const findFull = db.prepare('SELECT * FROM invoices WHERE invoice_number = ?');
  const findBySession = db.prepare('SELECT id, status FROM invoices WHERE stripe_session_id = ?');
  const acquireCheckoutLock = db.prepare(`
    UPDATE invoices
    SET checkout_lock_until = @lockUntil, updated_at = CURRENT_TIMESTAMP
    WHERE invoice_number = @invoiceNumber
      AND status != 'paid'
      AND (checkout_lock_until IS NULL OR checkout_lock_until < @now)
  `);
  const releaseCheckoutLock = db.prepare(`
    UPDATE invoices SET checkout_lock_until = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE invoice_number = ?
  `);
  const saveCheckout = db.prepare(`
    UPDATE invoices
    SET stripe_session_id = @sessionId,
        stripe_checkout_url = @url,
        stripe_session_expires_at = @expiresAt,
        checkout_lock_until = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE invoice_number = @invoiceNumber AND status != 'paid'
  `);
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO webhook_events
      (stripe_event_id, event_type, status, stripe_object_id)
    VALUES (@eventId, @eventType, 'processing', @objectId)
  `);
  const getEvent = db.prepare('SELECT * FROM webhook_events WHERE stripe_event_id = ?');
  const markEvent = db.prepare(`
    UPDATE webhook_events
    SET status = @status, invoice_id = @invoiceId, message = @message,
        processed_at = CURRENT_TIMESTAMP
    WHERE stripe_event_id = @eventId
  `);
  const markPaid = db.prepare(`
    UPDATE invoices
    SET status = 'paid', stripe_session_id = @sessionId,
        stripe_payment_intent = @paymentIntent, paid_at = @paidAt,
        checkout_lock_until = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = @invoiceId AND status != 'paid'
  `);
  const markFailed = db.prepare(`
    UPDATE invoices
    SET status = 'failed', stripe_payment_intent = COALESCE(stripe_payment_intent, @paymentIntent),
        updated_at = CURRENT_TIMESTAMP
    WHERE invoice_number = @invoiceNumber AND status != 'paid'
  `);

  const completeCheckout = db.transaction((event, session) => {
    const inserted = insertEvent.run({
      eventId: event.id,
      eventType: event.type,
      objectId: session.id
    });
    if (inserted.changes === 0) return { duplicate: true, event: getEvent.get(event.id) };

    const invoiceNumber = session.metadata?.invoice_number;
    const invoice = invoiceNumber ? findFull.get(invoiceNumber) : null;
    if (!invoice) {
      markEvent.run({ eventId: event.id, status: 'rejected', invoiceId: null, message: 'Invoice not found' });
      return { rejected: true, reason: 'invoice_not_found' };
    }
    if (invoice.status === 'paid') {
      markEvent.run({ eventId: event.id, status: 'ignored', invoiceId: invoice.id, message: 'Invoice already paid' });
      return { duplicate: true, invoice };
    }
    if (session.payment_status !== 'paid') {
      markEvent.run({ eventId: event.id, status: 'rejected', invoiceId: invoice.id, message: 'Session payment status is not paid' });
      return { rejected: true, reason: 'not_paid' };
    }
    if (session.amount_total !== invoice.amount || session.currency?.toLowerCase() !== invoice.currency.toLowerCase()) {
      markEvent.run({ eventId: event.id, status: 'rejected', invoiceId: invoice.id, message: 'Amount or currency mismatch' });
      return { rejected: true, reason: 'amount_mismatch' };
    }

    markPaid.run({
      invoiceId: invoice.id,
      sessionId: session.id,
      paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
      paidAt: new Date(event.created * 1000).toISOString()
    });
    markEvent.run({ eventId: event.id, status: 'processed', invoiceId: invoice.id, message: 'Invoice marked paid' });
    return { paid: true, invoiceNumber };
  });

  const recordFailure = db.transaction((event, intent) => {
    const inserted = insertEvent.run({
      eventId: event.id,
      eventType: event.type,
      objectId: intent.id
    });
    if (inserted.changes === 0) return { duplicate: true };
    const invoiceNumber = intent.metadata?.invoice_number;
    const invoice = invoiceNumber ? findFull.get(invoiceNumber) : null;
    const result = invoice
      ? markFailed.run({ paymentIntent: intent.id, invoiceNumber })
      : { changes: 0 };
    markEvent.run({
      eventId: event.id,
      status: result.changes ? 'processed' : 'ignored',
      invoiceId: invoice?.id || null,
      message: result.changes ? 'Invoice marked failed' : 'No pending invoice matched payment intent metadata'
    });
    return { failed: Boolean(result.changes) };
  });

  return {
    findPublic: invoiceNumber => findPublic.get(invoiceNumber),
    findFull: invoiceNumber => findFull.get(invoiceNumber),
    findStatusBySession: sessionId => findBySession.get(sessionId),
    acquireCheckoutLock: invoiceNumber => acquireCheckoutLock.run({
      invoiceNumber,
      now: Math.floor(Date.now() / 1000),
      lockUntil: Math.floor(Date.now() / 1000) + 30
    }).changes === 1,
    releaseCheckoutLock: invoiceNumber => releaseCheckoutLock.run(invoiceNumber),
    saveCheckout: values => saveCheckout.run(values),
    completeCheckout,
    recordFailure
  };
}

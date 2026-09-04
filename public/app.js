const form = document.getElementById('lookup-form');
const invoiceInput = document.getElementById('invoice-number');
const message = document.getElementById('lookup-message');
const card = document.getElementById('invoice-card');
const payButton = document.getElementById('pay-button');
let currentInvoice = null;

function formatMoney(amount, currency) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100);
}

function renderInvoice(invoice) {
  currentInvoice = invoice;
  document.getElementById('client-name').textContent = invoice.client_name;
  document.getElementById('due-date').textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${invoice.due_date}T00:00:00Z`));
  document.getElementById('invoice-reference').textContent = invoice.invoice_number;
  document.getElementById('balance').textContent = invoice.status === 'paid' ? 'PAID' : formatMoney(invoice.amount, invoice.currency);
  document.getElementById('invoice-status').textContent = invoice.status === 'paid' ? 'Payment confirmed' : 'Payment pending';
  payButton.hidden = invoice.status === 'paid';
  card.hidden = false;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  card.hidden = true;
  message.textContent = 'Looking up invoice…';
  const invoiceNumber = invoiceInput.value.trim().toUpperCase();
  try {
    const response = await fetch(`/api/invoices/${encodeURIComponent(invoiceNumber)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to find invoice');
    renderInvoice(data);
    message.textContent = '';
    history.replaceState(null, '', `/?invoice=${encodeURIComponent(invoiceNumber)}`);
  } catch (error) {
    message.textContent = error.message;
  }
});

payButton.addEventListener('click', async () => {
  if (!currentInvoice) return;
  payButton.disabled = true;
  payButton.textContent = 'Preparing payment…';
  try {
    const response = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceNumber: currentInvoice.invoice_number })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to start payment');
    location.assign(data.url);
  } catch (error) {
    message.textContent = error.message;
    payButton.disabled = false;
    payButton.textContent = 'Pay Now';
  }
});

const initialInvoice = new URLSearchParams(location.search).get('invoice');
if (initialInvoice) {
  invoiceInput.value = initialInvoice;
  form.requestSubmit();
}

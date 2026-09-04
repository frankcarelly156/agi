const translations = {
  en: {
    title: 'A&J Management | Payment Portal', description: 'A&J Management secure payment portal.', loadingAria: 'Loading invoice', secure: 'Secure', securePayment: 'Secure Payment', lookupTitle: 'Pay an invoice securely', lookupCopy: 'Enter the invoice number from your payment notice to view your bill.', invoiceNumber: 'Invoice Number', invoicePlaceholder: 'Enter Invoice Number', findInvoice: 'Find Invoice', invoiceReference: 'Invoice #INV2026001', portalTitle: 'A&J Management Legal Payment Portal', client: 'Client', dueDate: 'Due Date', dueDateValue: 'September 7, 2026', reference: 'Reference', referenceValue: 'Contract Termination File #KLTA2026001', balanceDue: 'Balance Due', viewBalance: 'View Balance In', paymentAmount: 'Payment Amount', payNow: 'Pay Now', paymentNote: 'Card payments are processed securely.', department: 'Legal Department & Talent Management', contact: 'Contact', email: 'Email: legal@ajmanagement.ch', phone: 'Phone: +44 333 057 1439', hours: 'Hours: Mon-Fri 9:00 — 17:00 CET', securePayments: 'Secure Payments', sslSecure: 'SSL Secure 🔒', pciCompliant: 'PCI Compliant', copyright: '© 2026 A&J Management. All rights reserved.', findingInvoice: 'Finding invoice…', invoiceNotFound: 'Invoice not found. Please check the number and try again.', amountRange: 'Enter an amount between $500.00 and $5,000.00 USD.', preparingPayment: 'Preparing payment…', paymentError: 'Unable to start payment.'
  },
  'fr-CA': {
    title: 'A&J Management | Portail de paiement', description: 'Portail de paiement sécurisé A&J Management.', loadingAria: 'Chargement de la facture', secure: 'Sécurisé', securePayment: 'Paiement sécurisé', lookupTitle: 'Payez une facture en toute sécurité', lookupCopy: 'Entrez le numéro de facture indiqué sur votre avis de paiement pour consulter votre facture.', invoiceNumber: 'Numéro de facture', invoicePlaceholder: 'Entrez le numéro de facture', findInvoice: 'Trouver la facture', invoiceReference: 'Facture #INV2026001', portalTitle: 'Portail de paiement juridique A&J Management', client: 'Client', dueDate: 'Date d’échéance', dueDateValue: '7 septembre 2026', reference: 'Référence', referenceValue: 'Résiliation de contrat Dossier #KLTA2026001', balanceDue: 'Solde dû', viewBalance: 'Afficher le solde en', paymentAmount: 'Montant du paiement', payNow: 'Payer maintenant', paymentNote: 'Les paiements par carte sont traités de façon sécurisée.', department: 'Service juridique et gestion des talents', contact: 'Coordonnées', email: 'Courriel : legal@ajmanagement.ch', phone: 'Téléphone : +44 333 057 1439', hours: 'Heures : lun ven 9 h à 17 h HEC', securePayments: 'Paiements sécurisés', sslSecure: 'SSL sécurisé 🔒', pciCompliant: 'Conforme PCI', copyright: '© 2026 A&J Management. Tous droits réservés.', findingInvoice: 'Recherche de la facture…', invoiceNotFound: 'Facture introuvable. Vérifiez le numéro et réessayez.', amountRange: 'Entrez un montant entre 500,00 $ et 5 000,00 $ US.', preparingPayment: 'Préparation du paiement…', paymentError: 'Impossible de commencer le paiement.'
  }
};

let locale = navigator.languages?.some(language => language.toLowerCase().startsWith('fr')) ? 'fr-CA' : 'en';

function t(key) {
  return translations[locale][key] || translations.en[key] || key;
}

function applyTranslations() {
  document.documentElement.lang = locale;
  document.title = t('title');
  document.getElementById('page-description').content = t('description');
  document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(element => { element.placeholder = t(element.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-aria]').forEach(element => { element.setAttribute('aria-label', t(element.dataset.i18nAria)); });
}

async function detectLocale() {
  try {
    const response = await fetch('/api/locale');
    if (response.ok) {
      const data = await response.json();
      if (data.locale === 'fr-CA') locale = data.locale;
    }
  } catch {
    // Direct local-file previews use the browser language fallback above.
  }
  applyTranslations();
}

const lookupForm = document.getElementById('lookup-form');
const lookupPanel = document.getElementById('lookup-panel');
const lookupInput = document.getElementById('invoice-number');
const lookupMessage = document.getElementById('lookup-message');
const lookupButton = lookupForm.querySelector('button[type="submit"]');
const loadingOverlay = document.getElementById('loading-overlay');
const shell = document.querySelector('.shell');
const invoiceFlow = document.getElementById('invoice-flow');
const form = document.getElementById('payment-form');
const currency = document.getElementById('currency');
const balance = document.getElementById('balance');
const balanceCurrency = document.getElementById('balance-currency');
const amountCurrency = document.getElementById('amount-currency');
const amountInput = document.getElementById('payment-amount');
const message = document.getElementById('payment-message');
const payButton = document.getElementById('pay-button');
const invoiceNumber = 'INV2026001';
const usdAmount = 5000;
const conversionRates = { USD: 1, CAD: 1.36, EUR: 0.92, GBP: 0.79, CHF: 0.9 };
const currencySymbols = { USD: '$', CAD: 'CA$', EUR: '€', GBP: '£', CHF: 'CHF ' };

function renderBalance() {
  const selectedCurrency = currency.value;
  const displayAmount = usdAmount * conversionRates[selectedCurrency];
  const display = `${currencySymbols[selectedCurrency]}${displayAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  balance.textContent = display;
  balanceCurrency.textContent = selectedCurrency;
}

function showInvoiceFlow() {
  lookupMessage.textContent = '';
  lookupPanel.hidden = true;
  invoiceFlow.hidden = false;
}

function setLookupLoading(isLoading) {
  loadingOverlay.hidden = !isLoading;
  shell.inert = isLoading;
  shell.setAttribute('aria-busy', String(isLoading));
  if (isLoading) loadingOverlay.focus();
}

currency.addEventListener('change', renderBalance);
lookupForm.addEventListener('submit', async event => {
  event.preventDefault();
  lookupButton.disabled = true;
  lookupButton.textContent = t('findingInvoice');
  lookupMessage.textContent = '';
  setLookupLoading(true);
  await new Promise(resolve => setTimeout(resolve, 2000));
  const enteredInvoice = lookupInput.value.trim().toUpperCase().replace(/^#/, '');
  if (enteredInvoice !== 'INV2026001') {
    setLookupLoading(false);
    lookupMessage.textContent = t('invoiceNotFound');
    lookupButton.disabled = false;
    lookupButton.textContent = t('findInvoice');
    return;
  }
  setLookupLoading(false);
  showInvoiceFlow();
  document.getElementById('invoice-title').focus({ preventScroll: true });
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const paymentAmount = Number(amountInput.value.replace(/,/g, '').trim());
  if (!Number.isFinite(paymentAmount) || paymentAmount < 500 || paymentAmount > 5000) {
    message.textContent = t('amountRange');
    amountInput.setAttribute('aria-invalid', 'true');
    amountInput.focus();
    return;
  }
  message.textContent = '';
  amountInput.removeAttribute('aria-invalid');
  payButton.disabled = true;
  payButton.classList.add('is-loading');
  payButton.textContent = t('preparingPayment');
  try {
    // The browser submits only the invoice reference. Payment totals remain
    // authoritative server-side.
    const response = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceNumber, paymentAmount: paymentAmount.toFixed(2) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || t('paymentError'));
    location.assign(data.url);
  } catch (error) {
    message.textContent = error.message;
    payButton.disabled = false;
    payButton.classList.remove('is-loading');
    payButton.textContent = t('payNow');
  }
});
renderBalance();
detectLocale();

const returnInvoice = new URLSearchParams(location.search).get('invoice');
if (returnInvoice?.replace(/^#/, '').replaceAll('-', '').toUpperCase() === 'INV2026001') {
  showInvoiceFlow();
}

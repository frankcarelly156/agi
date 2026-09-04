const statusMessage = document.getElementById('status-message');
const sessionId = new URLSearchParams(location.search).get('session_id');
let attempts = 0;

async function checkStatus() {
  if (!sessionId) {
    statusMessage.textContent = 'Your payment confirmation is being processed.';
    return;
  }
  try {
    const response = await fetch(`/api/payment-status?session_id=${encodeURIComponent(sessionId)}`);
    if (!response.ok) throw new Error('Status unavailable');
    const data = await response.json();
    if (data.status === 'paid') {
      statusMessage.textContent = 'Payment confirmed. This invoice is paid.';
      return;
    }
    attempts += 1;
    if (attempts < 10) return setTimeout(checkStatus, 1500);
    statusMessage.textContent = 'Payment confirmation is still processing. You may close this page.';
  } catch {
    statusMessage.textContent = 'Payment confirmation is still processing. You may close this page.';
  }
}
checkStatus();

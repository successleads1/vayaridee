// src/routes/partner.js
import express from 'express';

const router = express.Router();

/**
 * Local mock of the PayFast landing page.
 * You are redirected here from /pay/:rideId with query params.
 * Clicking the button will POST to /api/payfast/notify with m_payment_id
 * and payment_status=COMPLETE so your dispatch pipeline can proceed.
 */
router.get('/upgrade/payfast', (req, res) => {
  const {
    m_payment_id = '',     // ride id you passed (critical for mapping in IPN)
    partnerId = '',        // fallback id if present
    plan = 'basic',
    amount = '0.00',
    email = '',
    companyName = '',
    contactName = '',
  } = req.query;

  // Build notify URL using PUBLIC_URL if present, otherwise the current host.
  const base =
    (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const notifyUrl = `${base}/api/payfast/notify`;

  // Used to deep-link back to your Telegram bot (optional)
  // e.g. TELEGRAM_RIDER_BOT_USERNAME=YourRiderBot
  const tgUser = process.env.TELEGRAM_RIDER_BOT_USERNAME || '';

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Mock PayFast · Local</title>
  <style>
    :root { --pri:#635bff; --ok:#2e7d32; --err:#c62828; --bg:#f7f7fb; }
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:var(--bg);padding:24px}
    .card{max-width:640px;margin:0 auto;background:#fff;border-radius:14px;box-shadow:0 14px 38px rgba(0,0,0,.08);padding:24px}
    h1{margin:0 0 10px;font-size:22px}
    .row{margin:6px 0;color:#444}
    .muted{color:#777;font-size:13px;margin-top:10px}
    .actions{display:flex;gap:12px;margin-top:18px;flex-wrap:wrap}
    button{background:var(--ok);color:#fff;border:none;border-radius:10px;padding:12px 16px;font-size:16px;cursor:pointer}
    button.secondary{background:#e0e0e6;color:#222}
    button:disabled{opacity:.6;cursor:not-allowed}
    .ok{color:var(--ok)}
    .err{color:var(--err)}
    .debug{margin-top:14px;padding:10px;background:#f2f2f5;border-radius:8px;font-size:12px;color:#333;word-break:break-all}
  </style>
</head>
<body>
  <div class="card">
    <h1>🚀 Redirecting to PayFast (Local Mock)</h1>
    <div class="row"><b>Ride / Payment ID:</b> ${m_payment_id || partnerId || '-'}</div>
    <div class="row"><b>Plan:</b> ${plan}</div>
    <div class="row"><b>Amount:</b> R${amount}</div>
    <div class="row"><b>Email:</b> ${email || '-'}</div>
    <div class="row"><b>Company:</b> ${companyName || '-'}</div>
    <div class="row"><b>Contact:</b> ${contactName || '-'}</div>

    <p class="muted">This page simulates PayFast for development. Click the button below to mark the payment as COMPLETE.</p>

    <div class="actions">
      <button id="btn-ok">✅ Simulate PayFast SUCCESS</button>
      <button id="btn-cancel" class="secondary">❌ Cancel (no notify)</button>
    </div>

    <div id="msg" class="muted"></div>

    <div class="debug">
      <div><b>Notify URL:</b> ${notifyUrl}</div>
      <div><b>Telegram bot:</b> ${tgUser || '—'}</div>
    </div>
  </div>

  <script>
    const msg = document.getElementById('msg');
    const btnOk = document.getElementById('btn-ok');
    const btnCancel = document.getElementById('btn-cancel');

    const m_payment_id = ${JSON.stringify(m_payment_id || partnerId || '')};
    const notifyUrl    = ${JSON.stringify(notifyUrl)};
    const tgUser       = ${JSON.stringify(tgUser)};

    function goBackToTelegram() {
      if (!tgUser) return;
      // Try tg:// deep link first, then fallback to https://t.me, then close.
      try { window.location.href = 'tg://resolve?domain=' + tgUser; } catch(e) {}
      setTimeout(() => {
        try { window.location.href = 'https://t.me/' + tgUser; } catch(e) {}
      }, 600);
      setTimeout(() => { try { window.close(); } catch(e) {} }, 1200);
    }

    btnOk.onclick = async () => {
      btnOk.disabled = true;
      msg.textContent = 'Notifying server…';
      try {
        const body = new URLSearchParams({
          m_payment_id: m_payment_id,
          payment_status: 'COMPLETE'
        });
        const r = await fetch(notifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        if (!r.ok) throw new Error('Notify failed with status ' + r.status);
        msg.innerHTML = '<span class="ok">✅ Payment complete. You can return to Telegram.</span>';
        setTimeout(goBackToTelegram, 800);
      } catch (e) {
        msg.innerHTML = '<span class="err">❌ ' + (e && e.message ? e.message : 'Failed to notify') + '</span>';
        btnOk.disabled = false;
      }
    };

    btnCancel.onclick = () => {
      msg.textContent = 'Cancelled. This page will close.';
      setTimeout(() => { try { window.close(); } catch(e) {} }, 500);
    };
  </script>
</body>
</html>`);
});

export default router;

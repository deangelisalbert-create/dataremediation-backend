
// backend/src/routes/webhook.js
const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../config/database');

const router = express.Router();

// ⚠️ Ce endpoint reçoit le body RAW (pas JSON) — monté AVANT express.json() dans index.js
router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[WEBHOOK] Signature invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userEmail = session.customer_email || session.customer_details?.email;

    if (!userEmail) {
      console.warn('[WEBHOOK] Paiement reçu sans email client');
      return res.json({ received: true });
    }

    try {
      // Marquer le job le plus récent de cet utilisateur comme payé
      await pool.query(
        `UPDATE audit_jobs
         SET paid = true
         WHERE user_id = (SELECT id FROM users WHERE email = $1)
           AND paid = false
         ORDER BY created_at DESC
         LIMIT 1`,
        [userEmail]
      );
      console.log(`[WEBHOOK] Paiement confirmé pour ${userEmail}`);
    } catch (err) {
      console.error('[WEBHOOK] Erreur DB:', err.message);
      // On répond quand même 200 pour éviter que Stripe re-tente
    }
  }

  res.json({ received: true });
});

module.exports = router;

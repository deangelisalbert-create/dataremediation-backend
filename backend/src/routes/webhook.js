// backend/src/routes/webhook.js
const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../config/database');

const router = express.Router();

// ── Mapping liens Stripe → offres ─────────────────────────────────────────────
// Audits à l'acte
const AUDIT_LINKS = {
  'dRm9AMe876QN5qq5SXfQI01': { type: 'audit', quota: 50,  label: 'Starter' },
  '7sY5kw5BB6QN3ii6X1fQI02': { type: 'audit', quota: 200, label: 'PME BTP' },
  'bJe3coaVV1wt0661CHfQI03': { type: 'audit', quota: 500, label: 'PME Structuree' },
};

// Abonnements mensuels
const ABONNEMENT_LINKS = {
  'cNi00c9RRcb74mmeptfQI05': { type: 'abonnement', abonnement: 'starter',        quota: 50,   label: 'Suivi Starter' },
  '8x214g2pp7UR3ii1CHfQI06': { type: 'abonnement', abonnement: 'pme_btp',        quota: 200,  label: 'Suivi PME BTP' },
  '3cIaEQfcbcb7dWWchlfQI07': { type: 'abonnement', abonnement: 'pme_structuree', quota: 500,  label: 'Suivi PME Structuree' },
  '28EfZae87grn0664OTfQI08': { type: 'abonnement', abonnement: 'cabinet',        quota: 9999, label: 'Suivi Cabinet Comptable' },
};

const ALL_LINKS = { ...AUDIT_LINKS, ...ABONNEMENT_LINKS };

function getLinkId(paymentLink) {
  if (!paymentLink) return null;
  // Extraire l'ID depuis l'URL complète ou juste l'ID
  const parts = paymentLink.split('/');
  return parts[parts.length - 1];
}

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

  // ── Paiement one-shot (audit à l'acte) ───────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userEmail = session.customer_email || session.customer_details?.email;
    const paymentLinkId = getLinkId(session.payment_link);

    if (!userEmail) {
      console.warn('[WEBHOOK] Paiement reçu sans email');
      return res.json({ received: true });
    }

    const offre = ALL_LINKS[paymentLinkId];

    if (!offre) {
      console.warn('[WEBHOOK] Lien non reconnu:', paymentLinkId);
      // On marque quand même le paiement pour ne pas bloquer
      try {
        await pool.query(
          `UPDATE users SET credits = credits + 1 WHERE email = $1`,
          [userEmail]
        );
      } catch(e) { console.error('[WEBHOOK] Erreur DB fallback:', e.message); }
      return res.json({ received: true });
    }

    try {
      if (offre.type === 'audit') {
        // ── Audit à l'acte : ajouter 1 crédit ────────────
        await pool.query(
          `UPDATE users
           SET credits = credits + 1,
               plan = $2
           WHERE email = $1`,
          [userEmail, offre.label]
        );
        console.log(`[WEBHOOK] Audit ${offre.label} — +1 crédit pour ${userEmail}`);

      } else if (offre.type === 'abonnement') {
        // ── Abonnement : activer + quota mensuel ──────────
        const resetDate = new Date();
        resetDate.setMonth(resetDate.getMonth() + 1);

        await pool.query(
          `UPDATE users
           SET abonnement = $2,
               abonnement_quota = $3,
               abonnement_fournisseurs_restants = $3,
               abonnement_reset_date = $4,
               plan = $5
           WHERE email = $1`,
          [userEmail, offre.abonnement, offre.quota, resetDate.toISOString().split('T')[0], offre.label]
        );
        console.log(`[WEBHOOK] Abonnement ${offre.label} activé pour ${userEmail} — quota: ${offre.quota}`);
      }
    } catch (err) {
      console.error('[WEBHOOK] Erreur DB:', err.message);
    }
  }

  // ── Renouvellement abonnement mensuel ─────────────────
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    const customerEmail = invoice.customer_email;

    if (!customerEmail) return res.json({ received: true });

    try {
      // Remettre le quota à zéro pour le nouveau mois
      const resetDate = new Date();
      resetDate.setMonth(resetDate.getMonth() + 1);

      await pool.query(
        `UPDATE users
         SET abonnement_fournisseurs_restants = abonnement_quota,
             abonnement_reset_date = $2
         WHERE email = $1
           AND abonnement IS NOT NULL`,
        [customerEmail, resetDate.toISOString().split('T')[0]]
      );
      console.log(`[WEBHOOK] Renouvellement abonnement pour ${customerEmail}`);
    } catch(e) {
      console.error('[WEBHOOK] Erreur renouvellement:', e.message);
    }
  }

  // ── Résiliation abonnement ────────────────────────────
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerEmail = subscription.customer_email;

    if (!customerEmail) return res.json({ received: true });

    try {
      await pool.query(
        `UPDATE users
         SET abonnement = NULL,
             abonnement_quota = 0,
             abonnement_fournisseurs_restants = 0,
             abonnement_reset_date = NULL,
             plan = 'basic'
         WHERE email = $1`,
        [customerEmail]
      );
      console.log(`[WEBHOOK] Abonnement résilié pour ${customerEmail}`);
    } catch(e) {
      console.error('[WEBHOOK] Erreur résiliation:', e.message);
    }
  }

  res.json({ received: true });
});

module.exports = router;

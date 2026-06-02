// routes/abonnement.js — Gestion abonnements + webhook Stripe
const express = require('express');
const Stripe   = require('stripe');
const { authenticate } = require('../middleware/authenticate');
const { pool } = require('../config/database');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Plans Stripe -> quota fournisseurs
const PLANS = {
  'essentiel': { audits: 10,   fournisseurs: 50,   label: 'Essentiel' },
  'pro':       { audits: 30,   fournisseurs: 200,  label: 'Pro' },
  'cabinet':   { audits: 9999, fournisseurs: 500,  label: 'Cabinet' },
};

// ── GET /api/abonnement — Statut abonnement ───────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT abonnement_plan, abonnement_status, abonnement_quota,
              abonnement_used, abonnement_reset_at, stripe_customer_id
       FROM users WHERE tenant_id = $1 LIMIT 1`,
      [req.user.tenant_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    const u = result.rows[0];
    res.json({
      plan:           u.abonnement_plan,
      status:         u.abonnement_status,
      quota:          u.abonnement_quota,
      used:           u.abonnement_used,
      restant:        Math.max(0, (u.abonnement_quota||0) - (u.abonnement_used||0)),
      reset_at:       u.abonnement_reset_at,
      actif:          u.abonnement_status === 'active',
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/abonnement/webhook — Webhook Stripe ─────────
// IMPORTANT : cette route doit recevoir le body RAW (pas JSON parse)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch(err) {
    console.error('[Webhook] Signature invalide:', err.message);
    return res.status(400).json({ error: 'Webhook signature invalide.' });
  }

  console.log('[Webhook] Event recu:', event.type);

  try {
    switch(event.type) {

      // Abonnement cree ou reactive
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub      = event.data.object;
        const custId   = sub.customer;
        const planId   = sub.metadata?.plan || detectPlan(sub);
        const planInfo = PLANS[planId] || { quota: 50, label: planId };
        const status   = sub.status === 'active' ? 'active' : 'inactive';

        // Trouver le tenant via stripe_customer_id
        const userRes = await pool.query(
          'SELECT tenant_id FROM users WHERE stripe_customer_id = $1 LIMIT 1',
          [custId]
        );

        if (userRes.rows.length > 0) {
          const tenantId = userRes.rows[0].tenant_id;
          await pool.query(
            `UPDATE users SET
               abonnement_plan = $1,
               abonnement_status = $2,
               abonnement_quota = $3,
               abonnement_reset_at = $4,
               stripe_sub_id = $5
             WHERE tenant_id = $6`,
            [planId, status, planInfo.quota,
             new Date(sub.current_period_end * 1000),
             sub.id, tenantId]
          );
          await logEvent(tenantId, event.id, event.type, planId, planInfo.quota, null);
          console.log('[Webhook] Abonnement mis a jour pour tenant', tenantId, '- plan', planId);
        }
        break;
      }

      // Paiement reussi -> reset quota used
      case 'invoice.payment_succeeded': {
        const invoice  = event.data.object;
        const custId   = invoice.customer;
        const userRes  = await pool.query(
          'SELECT tenant_id FROM users WHERE stripe_customer_id = $1 LIMIT 1',
          [custId]
        );
        if (userRes.rows.length > 0) {
          const tenantId = userRes.rows[0].tenant_id;
          await pool.query(
            `UPDATE users SET abonnement_used = 0 WHERE tenant_id = $1`,
            [tenantId]
          );
          await logEvent(tenantId, event.id, event.type, null, null, Math.round((invoice.amount_paid||0)/100));
          console.log('[Webhook] Quota reset pour tenant', tenantId);
        }
        break;
      }

      // Abonnement annule
      case 'customer.subscription.deleted': {
        const sub     = event.data.object;
        const custId  = sub.customer;
        const userRes = await pool.query(
          'SELECT tenant_id FROM users WHERE stripe_customer_id = $1 LIMIT 1',
          [custId]
        );
        if (userRes.rows.length > 0) {
          const tenantId = userRes.rows[0].tenant_id;
          await pool.query(
            `UPDATE users SET abonnement_status = 'cancelled', abonnement_quota = 0
             WHERE tenant_id = $1`,
            [tenantId]
          );
          await logEvent(tenantId, event.id, event.type, null, 0, null);
          console.log('[Webhook] Abonnement annule pour tenant', tenantId);
        }
        break;
      }

      // Checkout complete (premier paiement)
      case 'checkout.session.completed': {
        const session  = event.data.object;
        const custId   = session.customer;
        const email    = session.customer_details?.email;
        const planId   = session.metadata?.plan;

        if (email) {
          // Associer le stripe_customer_id a l'utilisateur via son email
          await pool.query(
            `UPDATE users SET stripe_customer_id = $1 WHERE email = $2`,
            [custId, email]
          );
          console.log('[Webhook] Customer Stripe lie a', email);
        }
        break;
      }

      default:
        console.log('[Webhook] Event ignore:', event.type);
    }

    res.json({ received: true });
  } catch(err) {
    console.error('[Webhook] Erreur traitement:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/abonnement/create-customer ─────────────────
// Creer un customer Stripe pour l'utilisateur courant
router.post('/create-customer', authenticate, async (req, res) => {
  try {
    const userRes = await pool.query(
      'SELECT email, company, stripe_customer_id FROM users WHERE tenant_id = $1 LIMIT 1',
      [req.user.tenant_id]
    );
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });

    const u = userRes.rows[0];
    if (u.stripe_customer_id) return res.json({ customer_id: u.stripe_customer_id });

    // Creer le customer dans Stripe
    const customer = await stripe.customers.create({
      email: u.email,
      name:  u.company,
      metadata: { tenant_id: req.user.tenant_id },
    });

    await pool.query(
      'UPDATE users SET stripe_customer_id = $1 WHERE tenant_id = $2',
      [customer.id, req.user.tenant_id]
    );

    res.json({ customer_id: customer.id });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────
function detectPlan(sub) {
  const items = sub.items?.data || [];
  for (const item of items) {
    const nickname = (item.price?.nickname || '').toLowerCase();
    if (nickname.includes('cabinet')) return 'cabinet-comptable';
    if (nickname.includes('structuree') || nickname.includes('structurée')) return 'pme-structuree';
    if (nickname.includes('btp')) return 'pme-btp';
    if (nickname.includes('starter')) return 'starter';
  }
  return 'starter';
}

async function logEvent(tenantId, stripeEventId, eventType, plan, quota, montant) {
  try {
    await pool.query(
      `INSERT INTO abonnement_events (tenant_id, stripe_event_id, event_type, plan, quota, montant_eur)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (stripe_event_id) DO NOTHING`,
      [tenantId, stripeEventId, eventType, plan, quota, montant]
    );
  } catch(e) {
    console.warn('[Webhook] Erreur log event:', e.message);
  }
}

module.exports = router;

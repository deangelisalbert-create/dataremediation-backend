// routes/abonnement.js — Gestion abonnements + webhook Stripe
const express = require('express');
const Stripe   = require('stripe');
const { authenticate } = require('../middleware/authenticate');
const { pool } = require('../config/database');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Plans Stripe -> quota fournisseurs (audits illimites)
const PLANS = {
  'essentiel': { fournisseurs: 50,  label: 'Essentiel', montant: 29000 },
  'pro':       { fournisseurs: 200, label: 'Pro',       montant: 49900 },
  'cabinet':   { fournisseurs: 500, label: 'Cabinet',   montant: 89900 },
};

// Detection du plan depuis le montant en centimes
function detectPlanFromAmount(amount) {
  if (amount <= 29000) return 'essentiel';
  if (amount <= 49900) return 'pro';
  return 'cabinet';
}

function detectPlanFromSub(sub) {
  const items = sub.items?.data || [];
  for (const item of items) {
    const nickname = (item.price?.nickname || '').toLowerCase();
    const amount   = item.price?.unit_amount || 0;
    if (nickname.includes('cabinet'))   return 'cabinet';
    if (nickname.includes('pro'))       return 'pro';
    if (nickname.includes('essentiel')) return 'essentiel';
    // Fallback par montant
    if (amount >= 89900) return 'cabinet';
    if (amount >= 49900) return 'pro';
    if (amount >= 29000) return 'essentiel';
  }
  return 'essentiel';
}

// ── GET /api/abonnement — Statut abonnement utilisateur ──
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT abonnement_plan, abonnement_status, abonnement_quota_fournisseurs,
              abonnement_reset_at, stripe_customer_id
       FROM users WHERE tenant_id = $1 LIMIT 1`,
      [req.user.tenant_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    const u = result.rows[0];
    res.json({
      plan:    u.abonnement_plan,
      status:  u.abonnement_status,
      actif:   u.abonnement_status === 'active',
      quota_fournisseurs: u.abonnement_quota_fournisseurs,
      reset_at: u.abonnement_reset_at,
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/abonnement/webhook — Webhook Stripe ─────────
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig           = req.headers['stripe-signature'];
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

      // ── Checkout complete (premier paiement) ───────────
      case 'checkout.session.completed': {
        const session   = event.data.object;
        const dossierId = session.client_reference_id;
        const email     = session.customer_details?.email;
        const custId    = session.customer;
        const amount    = session.amount_total || 0;
        const plan      = session.metadata?.plan || detectPlanFromAmount(amount);
        const planInfo  = PLANS[plan] || PLANS['essentiel'];

        console.log('[Webhook] Checkout complete - dossier:', dossierId, '- plan:', plan, '- email:', email);

        // Lier le customer Stripe a l'utilisateur via email
        if (email) {
          await pool.query(
            `UPDATE users SET stripe_customer_id = $1 WHERE email = $2`,
            [custId, email]
          );
          console.log('[Webhook] Customer Stripe lie a', email);
        }

        // Activer l'abonnement sur le dossier
        if (dossierId) {
          await pool.query(
            `UPDATE client_dossiers SET
               abonnement_plan = $1,
               abonnement_status = 'active',
               abonnement_quota_fournisseurs = $2,
               abonnement_reset_at = NOW() + INTERVAL '1 month',
               stripe_customer_id = $3,
               updated_at = NOW()
             WHERE id = $4`,
            [plan, planInfo.fournisseurs, custId, dossierId]
          );
          console.log('[Webhook] Abonnement', plan, 'active sur dossier', dossierId);
          await logEvent(dossierId, event.id, event.type, plan, planInfo.fournisseurs, Math.round(amount/100));
        }
        break;
      }

      // ── Abonnement cree ou mis a jour ──────────────────
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub    = event.data.object;
        const custId = sub.customer;
        const plan   = detectPlanFromSub(sub);
        const planInfo = PLANS[plan] || PLANS['essentiel'];
        const status = sub.status === 'active' ? 'active' : 'inactive';

        // Mise a jour du dossier via stripe_customer_id
        const dossierRes = await pool.query(
          `SELECT id FROM client_dossiers WHERE stripe_customer_id = $1 LIMIT 1`,
          [custId]
        );

        if (dossierRes.rows.length > 0) {
          const dossierId = dossierRes.rows[0].id;
          await pool.query(
            `UPDATE client_dossiers SET
               abonnement_plan = $1,
               abonnement_status = $2,
               abonnement_quota_fournisseurs = $3,
               abonnement_reset_at = $4,
               stripe_sub_id = $5,
               updated_at = NOW()
             WHERE id = $6`,
            [plan, status, planInfo.fournisseurs,
             new Date(sub.current_period_end * 1000),
             sub.id, dossierId]
          );
          await logEvent(dossierId, event.id, event.type, plan, planInfo.fournisseurs, null);
          console.log('[Webhook] Abonnement mis a jour dossier', dossierId, '- plan', plan, '- status', status);
        }

        // Mise a jour aussi sur le compte utilisateur
        const userRes = await pool.query(
          `SELECT tenant_id FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
          [custId]
        );
        if (userRes.rows.length > 0) {
          await pool.query(
            `UPDATE users SET
               abonnement_plan = $1,
               abonnement_status = $2,
               abonnement_quota_fournisseurs = $3,
               abonnement_reset_at = $4,
               stripe_sub_id = $5
             WHERE stripe_customer_id = $6`,
            [plan, status, planInfo.fournisseurs,
             new Date(sub.current_period_end * 1000),
             sub.id, custId]
          );
        }
        break;
      }

      // ── Paiement mensuel reussi → reset quota ──────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const custId  = invoice.customer;

        // Reset sur le dossier
        await pool.query(
          `UPDATE client_dossiers SET
             abonnement_reset_at = NOW() + INTERVAL '1 month',
             updated_at = NOW()
           WHERE stripe_customer_id = $1 AND abonnement_status = 'active'`,
          [custId]
        );

        await logEvent(null, event.id, event.type, null, null, Math.round((invoice.amount_paid||0)/100));
        console.log('[Webhook] Paiement mensuel OK pour customer', custId);
        break;
      }

      // ── Abonnement annule ──────────────────────────────
      case 'customer.subscription.deleted': {
        const sub    = event.data.object;
        const custId = sub.customer;

        await pool.query(
          `UPDATE client_dossiers SET
             abonnement_status = 'cancelled',
             updated_at = NOW()
           WHERE stripe_customer_id = $1`,
          [custId]
        );

        await pool.query(
          `UPDATE users SET abonnement_status = 'cancelled'
           WHERE stripe_customer_id = $1`,
          [custId]
        );

        await logEvent(null, event.id, event.type, null, 0, null);
        console.log('[Webhook] Abonnement annule pour customer', custId);
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
router.post('/create-customer', authenticate, async (req, res) => {
  try {
    const userRes = await pool.query(
      'SELECT email, company, stripe_customer_id FROM users WHERE tenant_id = $1 LIMIT 1',
      [req.user.tenant_id]
    );
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });

    const u = userRes.rows[0];
    if (u.stripe_customer_id) return res.json({ customer_id: u.stripe_customer_id });

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

// ── Helper log event ──────────────────────────────────────
async function logEvent(tenantId, stripeEventId, eventType, plan, quota, montant) {
  try {
    await pool.query(
      `INSERT INTO abonnement_events (tenant_id, stripe_event_id, event_type, plan, quota, montant_eur)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (stripe_event_id) DO NOTHING`,
      [tenantId || 'unknown', stripeEventId, eventType, plan, quota, montant]
    );
  } catch(e) {
    console.warn('[Webhook] Erreur log event:', e.message);
  }
}

module.exports = router;

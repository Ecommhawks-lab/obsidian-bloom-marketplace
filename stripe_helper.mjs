// Stripe Connect (Express) helpers. Optional — only active if STRIPE_SECRET is set.
import Stripe from 'stripe';

const KEY = process.env.STRIPE_SECRET || '';
const stripe = KEY ? new Stripe(KEY) : null;

export const stripeEnabled = !!stripe;

export async function ensureAccount(vendor) {
  if (!stripe) throw new Error('Stripe not configured.');
  if (vendor.stripe_account_id) return vendor.stripe_account_id;
  const acct = await stripe.accounts.create({
    type: 'express',
    email: vendor.email,
    business_profile: { name: vendor.business_name },
    capabilities: { transfers: { requested: true } },
  });
  return acct.id;
}

export async function onboardingLink(accountId, base) {
  if (!stripe) throw new Error('Stripe not configured.');
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${base}/dashboard?stripe=refresh`,
    return_url: `${base}/dashboard?stripe=done`,
    type: 'account_onboarding',
  });
  return link.url;
}

export async function accountStatus(accountId) {
  if (!stripe || !accountId) return { connected: false };
  const a = await stripe.accounts.retrieve(accountId);
  return { connected: true, charges_enabled: a.charges_enabled, payouts_enabled: a.payouts_enabled, details_submitted: a.details_submitted };
}

// Pay a vendor their net earnings (see README for the funding caveat).
export async function payout(accountId, amountCents, currency) {
  if (!stripe) throw new Error('Stripe not configured.');
  return stripe.transfers.create({ amount: amountCents, currency: (currency || 'usd').toLowerCase(), destination: accountId });
}

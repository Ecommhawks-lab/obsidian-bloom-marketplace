// Stripe Connect (Express) over plain fetch. Active only when STRIPE_SECRET is set.
// Payout caveat: Shopify checkout money lands in Shopify Payments, not Stripe.
// A transfer succeeds only if the Stripe platform balance is funded.

export function makeStripe(env) {
  const KEY = env.STRIPE_SECRET || '';
  const enabled = !!KEY;

  async function call(method, path, params) {
    const headers = { Authorization: `Bearer ${KEY}` };
    let body;
    if (params) { body = new URLSearchParams(params).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    const res = await fetch(`https://api.stripe.com/v1/${path}`, { method, headers, body });
    const json = await res.json();
    if (!res.ok) throw new Error('Stripe: ' + (json.error?.message || res.status));
    return json;
  }

  return {
    enabled,
    async ensureAccount({ email, name, stripe_account_id }) {
      if (!enabled) throw new Error('Stripe is not configured.');
      if (stripe_account_id) return stripe_account_id;
      const acct = await call('POST', 'accounts', {
        type: 'express', email,
        'business_profile[name]': name || email,
        'capabilities[transfers][requested]': 'true',
      });
      return acct.id;
    },
    async onboardingLink(accountId, returnUrl) {
      if (!enabled) throw new Error('Stripe is not configured.');
      const link = await call('POST', 'account_links', {
        account: accountId,
        refresh_url: `${returnUrl}?stripe=refresh`,
        return_url: `${returnUrl}?stripe=done`,
        type: 'account_onboarding',
      });
      return link.url;
    },
    async accountStatus(accountId) {
      if (!enabled || !accountId) return { connected: false };
      const a = await call('GET', `accounts/${accountId}`);
      return { connected: true, payouts_enabled: !!a.payouts_enabled, details_submitted: !!a.details_submitted };
    },
    async transfer(accountId, amountCents, currency, description) {
      if (!enabled) throw new Error('Stripe is not configured.');
      return call('POST', 'transfers', {
        amount: String(amountCents), currency: (currency || 'ils').toLowerCase(),
        destination: accountId, description: description || 'Mercado Bloom payout',
      });
    },
  };
}

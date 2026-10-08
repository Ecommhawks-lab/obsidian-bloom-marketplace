// Stripe Connect (Express) helpers via plain fetch (Workers-native; no SDK).
// Optional — only active when STRIPE_SECRET is set. See README payout caveat.

export function makeStripe(env) {
  const KEY = env.STRIPE_SECRET || '';
  const enabled = !!KEY;

  async function call(method, path, params) {
    const headers = { Authorization: `Bearer ${KEY}` };
    let body;
    if (params) {
      body = new URLSearchParams(params).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(`https://api.stripe.com/v1/${path}`, { method, headers, body });
    const json = await res.json();
    if (!res.ok) throw new Error('Stripe: ' + (json.error?.message || res.status));
    return json;
  }

  return {
    enabled,

    async ensureAccount(vendor) {
      if (!enabled) throw new Error('Stripe not configured.');
      if (vendor.stripe_account_id) return vendor.stripe_account_id;
      const acct = await call('POST', 'accounts', {
        type: 'express',
        email: vendor.email,
        'business_profile[name]': vendor.business_name,
        'capabilities[transfers][requested]': 'true',
      });
      return acct.id;
    },

    async onboardingLink(accountId, base) {
      if (!enabled) throw new Error('Stripe not configured.');
      const link = await call('POST', 'account_links', {
        account: accountId,
        refresh_url: `${base}/dashboard?stripe=refresh`,
        return_url: `${base}/dashboard?stripe=done`,
        type: 'account_onboarding',
      });
      return link.url;
    },

    async accountStatus(accountId) {
      if (!enabled || !accountId) return { connected: false };
      const a = await call('GET', `accounts/${accountId}`);
      return {
        connected: true,
        charges_enabled: a.charges_enabled,
        payouts_enabled: a.payouts_enabled,
        details_submitted: a.details_submitted,
      };
    },

    async payout(accountId, amountCents, currency) {
      if (!enabled) throw new Error('Stripe not configured.');
      return call('POST', 'transfers', {
        amount: String(amountCents),
        currency: (currency || 'usd').toLowerCase(),
        destination: accountId,
      });
    },
  };
}

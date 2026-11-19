# Mercado Bloom app: setup (about 30 minutes)

This replaces the old standalone "Obsidian Bloom" worker with a real Shopify app. It keeps the same Cloudflare Worker name, the same URL and the same Turso database. Old vendors, products and earnings are copied into the new tables automatically on first run. The old tables stay untouched.

What you need: the Shopify Partner account, Cloudflare (where the worker already runs), GitHub, and a Mac with Node 18 or newer.

## 1. Put the code in GitHub

1. In `Ecommhawks-lab/obsidian-bloom-marketplace`, delete the old files at the root: `worker.mjs`, `auth.mjs`, `db.mjs`, `shopify.mjs`, `stripe.mjs` and the `public/` folder.
2. Copy everything from this folder in (`src/`, `scripts/`, `test/`, `package.json`, `wrangler.jsonc`, `shopify.app.toml`, `README.md`, `SETUP.md`). Commit and push.
3. If the worker is connected to Git, Cloudflare redeploys by itself. If not, run `npm install` then `npm run deploy`.
4. Check that `https://obsidian-bloom-marketplace.mercado-bloom.workers.dev/health` returns `{"ok":true}`.

## 2. Create the app in your Partner account

1. Go to Partners → **Apps** → **Create app** → **Create app manually**. Name it **Mercado Bloom Marketplace**.
2. Copy the **Client ID** and the **Client secret**.
3. Under **Distribution**, choose **Custom distribution**, enter `flowersmarketplace.myshopify.com`, and generate the install link. Keep the link for step 5.

## 3. Add the secrets in Cloudflare

Go to Workers → obsidian-bloom-marketplace → Settings → **Variables and Secrets** and add these as **Secret**:

| Name | Value |
|---|---|
| `SHOPIFY_API_KEY` | Client ID from step 2 |
| `SHOPIFY_API_SECRET` | Client secret from step 2 |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Already there, keep them |
| `STRIPE_SECRET` | Optional: Stripe secret key (`sk_live_...`) |
| `RESEND_API_KEY` | Optional: for emails (resend.com) |

If you use email, also set the plain variable `NOTIFY_FROM` in `wrangler.jsonc`, for example `"Mercado Bloom <noreply@yourdomain>"`.

The old secrets (`ADMIN_TOKEN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `JWT_SECRET`) are no longer used. Delete them once step 6 is done.

## 4. Push the app settings (Shopify CLI, once)

```bash
npm install -g @shopify/cli
cd obsidian-bloom-marketplace
# open shopify.app.toml and replace PASTE_CLIENT_ID_FROM_DEV_DASHBOARD with the Client ID
shopify app deploy        # log in with the Partner account when asked
```

This command registers:

- the app URL
- the permissions (scopes)
- the **app proxy**, so `flowersmarketplace.myshopify.com/apps/mb/...` points to the worker
- the order webhook and the three privacy (compliance) webhooks

The app proxy and the privacy webhooks can only be set this way.

## 5. Install on the store

1. Open the install link from step 2. Approve the permissions.
2. Open **Apps → Mercado Bloom Marketplace** in Shopify admin. The dashboard opens, and the first open links the store to the app.
3. Go to **Settings** in the app. Check the commission (15%), the price uplift (₪25) and the courier pay per delivery (₪25).

## 6. Theme

1. Replace `sections/mb-join-form.liquid` with the new file. The join forms now send applications, with photos, to the app.
   - If the app can't be reached, the form falls back to email, so no application is lost.
   - You can turn this off per form: Customize → the form section → "Send to the Mercado Bloom app".
2. Optional: add to the menu "אזור יוצרים" → `/apps/mb/creator` and "אזור שליחים" → `/apps/mb/courier`.
3. Once everything works, delete the old custom app in Settings → Apps and sales channels → Develop apps. Its token was used by the old worker; deleting the app revokes it.

## 7. Test it end to end (10 minutes)

1. Submit `/pages/join-creators` with a test email.
   - In the app: **Applications** shows the request with its photos.
   - In Shopify Customers: the test customer has the tag `creator-pending`.
2. Approve the application. The customer tag changes to `creator-approved`, and the creator appears on `/pages/creators`.
3. On the store, log in with that email and open `/apps/mb/creator`. Add a product with a photo. It appears in the app under **Product approval** as a draft, with ₪25 added to the price.
4. Approve the product. It goes live on the store.
5. Submit `/pages/join-couriers` and approve it, choosing delivery areas that include the city of your test order.
6. Place a test order to that city. Check:
   - **Orders** shows the order and the creator's earnings.
   - **Couriers & deliveries** shows the delivery assigned to the courier.
7. As the courier, open `/apps/mb/courier`. Mark the delivery as picked up, then as delivered. The order is fulfilled in Shopify and the customer gets the shipping email.
8. In **Payouts**, mark the creator and the courier as paid.

## Good to know

- **Who can enter the creator or courier area.** Only logged-in customers whose application was approved. This is checked on the server for every request, using Shopify's signed app-proxy requests. A link alone gives no access.
- **Product approval.** Every new product starts as a draft and goes live only after you approve it. When a creator edits a live product, the product stays live and is flagged "edited after approval" for you to review.
- **Daily capacity.** If a creator sets one, the app counts their orders each day (Israel time). When the limit is reached, their products show as sold out, and they become available again after midnight.
- **Stripe payouts.** Shopify checkout money lands in Shopify Payments, not Stripe. A Stripe transfer only works if your Stripe balance is topped up. Also check that Stripe Connect supports your platform's country before relying on it. "Mark as paid" (bank transfer or Bit) always works.
- **Access tokens.** The app uses Shopify's expiring access tokens and refreshes them by itself every hour.
- **Tests.** `npm install && npm test` runs 64 end-to-end checks against a mocked Shopify.

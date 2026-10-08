# Obsidian Bloom — Multi-Vendor Marketplace

A working multi-tenant marketplace on **one** Shopify store, running on **Cloudflare Workers** with a **Turso** database. Vendors (florists) sign up and log in, publish products **attributed to them**, an **admin** reviews and approves, and **Stripe Connect** handles vendor payouts backed by an earnings ledger fed by a Shopify orders webhook.

## Roles & flow

1. **Vendor** signs up → `/dashboard` → uploads a bouquet (image, name, narrative, price, stem density) → **Publish**. A **draft** product is created in your Shopify store with `vendor = business name`, tag `vendor:<id>`, and metafield `custom.vendor_id`. It shows in *My Collection* as **pending**.
2. **Admin** (store owner) logs in → `/admin` → sees every submission → **Approve** (sets the Shopify product to ACTIVE) or **Reject** (keeps it DRAFT).
3. Orders come in → Shopify fires the **orders webhook** → the app records each vendor's net earnings (gross − commission) in the ledger.
4. **Vendor** connects **Stripe** on their dashboard. Admin sees amounts owed and hits **Pay out**.

## Stack

Cloudflare Workers + **Hono** (router), **Turso/libSQL** (`@libsql/client/web`) for storage, **jose** JWT cookie sessions, **Web Crypto PBKDF2** password hashing, and plain-`fetch` calls to the Shopify Admin GraphQL API and Stripe. No Node server, no Docker — it runs on the Workers runtime. Files: `src/worker.mjs` (routes), `src/db.mjs`, `src/auth.mjs`, `src/shopify.mjs`, `src/stripe.mjs`, `public/` (login, signup, dashboard, admin — bundled as text), `wrangler.jsonc`.

Why this stack: Cloudflare Workers' free tier is genuinely free (no card, no expiry) and allows commercial use, and Turso's free tier is persistent — so the whole marketplace runs at **$0** with data that survives restarts.

## Configuration

Non-secret config is in `wrangler.jsonc` → `vars` (`SHOP`, `API_VERSION`, `PRODUCT_TYPE`, `PLATFORM_COMMISSION_PCT`).

Secrets are set in the Cloudflare dashboard (Workers → your worker → Settings → Variables and Secrets → **Secret**) or via `npx wrangler secret put <NAME>`:
`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `ADMIN_TOKEN`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and optionally `STRIPE_SECRET`, `SHOPIFY_WEBHOOK_SECRET`. See `.env.example`.

## Deploy

**Option A — Git (no CLI):** push this repo to GitHub, then in the Cloudflare dashboard: Workers → Create → **Connect to Git**, pick the repo. Cloudflare runs `npm ci` and `npx wrangler deploy`. Add the secrets above in the Worker's settings and redeploy.

**Option B — CLI:** `npm install` then `npx wrangler deploy`. Set secrets with `npx wrangler secret put <NAME>`.

Tables are created automatically on first request. Routes: `/signup` (vendor), `/login` (vendor or admin tab), `/dashboard`, `/admin`.

### Orders webhook (optional, for the earnings ledger)
In Shopify admin → Settings → Notifications → Webhooks, add an **Order creation** webhook (JSON) to `https://YOUR_WORKER_URL/webhooks/orders`, and set `SHOPIFY_WEBHOOK_SECRET` to its signing secret.

## ⚠️ The payout funding caveat (read this)

Money from a **Shopify checkout** lands in the store's **Shopify Payments** balance — **not** in your Stripe platform balance. A Stripe `transfer` to a vendor only succeeds if your Stripe platform account holds funds. Options: manual reconciliation using the earnings ledger as the source of truth (this app, as-is); take payment through Stripe instead of Shopify checkout (bigger change); or use a Shopify-native payout app. The app never stores raw bank details — payout data lives only in Stripe.

## Notes

- Products publish as **draft** until an admin approves (change `'DRAFT'`→`'ACTIVE'` in `src/shopify.mjs` for auto-publish).
- Single Shopify store, many app-level vendor accounts. Vendors authenticate against this app (not Shopify OAuth) since they aren't store staff.
- Commission set by `PLATFORM_COMMISSION_PCT`. The webhook is idempotent per (vendor, order).

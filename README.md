# Obsidian Bloom — Multi-Vendor Marketplace

A working multi-tenant marketplace on **one** Shopify store. Vendors (florists) sign up and log in, publish products **attributed to them**, an **admin** reviews and approves, and **Stripe Connect** handles vendor payouts backed by an earnings ledger fed by a Shopify orders webhook.

## Roles & flow

1. **Vendor** signs up → `/dashboard` → uploads a bouquet (image, name, narrative, price, stem density) → **Publish**. A **draft** product is created in your Shopify store with `vendor = business name`, tag `vendor:<id>`, and metafield `custom.vendor_id`. It shows in *My Collection* as **pending**.
2. **Admin** (store owner) logs in → `/admin` → sees every submission → **Approve** (sets the Shopify product to ACTIVE) or **Reject** (keeps it DRAFT).
3. Orders come in → Shopify fires the **orders webhook** → the app records each vendor's net earnings (gross − commission) in the ledger.
4. **Vendor** connects **Stripe** on their dashboard. Admin sees amounts owed and hits **Pay out**, which creates a Stripe transfer to the vendor's connected account and marks those earnings paid.

## Stack

Node 18–22, Express, SQLite (`better-sqlite3`), JWT cookie sessions, bcrypt, Stripe SDK. No build step. Files: `server.mjs` (routes), `db.mjs`, `auth.mjs`, `shopify.mjs`, `stripe_helper.mjs`, `public/` (login, signup, dashboard, admin).

## Setup

1. **Shopify custom app** → Settings → Apps → Develop apps → create app → Admin API scopes `write_products`, `read_products` → install → copy the `shpat_` token.
2. Configure and run:
   ```bash
   cd obsidian-bloom-marketplace
   cp .env.example .env      # fill SHOP, ADMIN_TOKEN, JWT_SECRET, ADMIN_EMAIL/PASSWORD
   npm install
   npm start                 # http://localhost:8890
   ```
   `/signup` (vendor), `/login` (vendor or admin tab), `/admin` (store owner).
3. **Stripe (optional):** set `STRIPE_SECRET` to enable "Connect Stripe" + payouts. Uses Stripe Connect **Express** accounts.
4. **Orders webhook (optional):** in Shopify admin → Settings → Notifications → Webhooks, add an **Order creation** webhook (JSON) to `https://YOUR_HOST/webhooks/orders`, and put its signing secret in `SHOPIFY_WEBHOOK_SECRET`. This populates the earnings ledger.

## Hosting

Deploy to any Node host (Render, Railway, Fly, VPS). Set the same env vars, set `NODE_ENV=production` and `BASE_URL=https://your-domain` (enables secure cookies and correct Stripe return links). Persist the SQLite file (`DB_PATH`) on a volume, or swap `db.mjs` to Postgres for scale.

## ⚠️ The payout funding caveat (read this)

Money from a **Shopify checkout** lands in the store's **Shopify Payments** balance — **not** in your Stripe platform balance. So a Stripe `transfer` to a vendor only succeeds if your Stripe platform account actually holds funds. Practical options:

- **Manual reconciliation (this app, as-is):** use the earnings ledger + "amount owed" per vendor as the source of truth, top up / fund your Stripe balance, then pay out. Correct amounts, semi-automatic.
- **Take payment through Stripe instead of Shopify checkout** (Stripe as the marketplace processor) — then `transfer`/`application_fee` splits are fully automatic. Bigger change.
- **Use a Shopify-native payout app** (Shopify Collective, Webkul Multivendor) if you want Shopify to move the money.

The app never stores raw bank details — payout data lives only in Stripe (PCI-compliant).

## Notes

- Products publish as **draft** until an admin approves (change `'DRAFT'`→`'ACTIVE'` in `shopify.mjs` for auto-publish).
- Single Shopify store, many app-level vendor accounts. Vendors authenticate against this app (not Shopify OAuth) since they aren't store staff.
- Commission set by `PLATFORM_COMMISSION_PCT`. Webhook is idempotent per (vendor, order).

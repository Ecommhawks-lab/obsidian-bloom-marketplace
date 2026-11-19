# Mercado Bloom — marketplace Shopify app

One Shopify store, many creators (florists and makers) and couriers. Runs on **Cloudflare Workers** (Hono) with a **Turso** database. Set it up with [SETUP.md](SETUP.md).

## What it does

| Who | Where | What |
|---|---|---|
| Store owner | Shopify admin → Apps → Mercado Bloom | Approve or reject creator and courier applications; review products (approving publishes them); creators (capacity, commission, suspend); orders; deliveries (auto or manual courier assignment); payouts (Stripe or mark paid); settings |
| Creator | `store/apps/mb/creator` | Earnings dashboard (week, month, 6 months, year to date); products screen like Shopify's (photos, price, options, category); orders; shop profile (logo, city, bio, daily capacity); store link to share; Stripe connect |
| Courier | `store/apps/mb/courier` | Assigned deliveries with address, phone, Waze and pickup creator; picked-up and delivered buttons (delivered fulfils the order in Shopify); history; delivery areas and availability |
| Visitor | `/pages/join-creators`, `/pages/join-couriers` | Application forms with photo upload; saved in the app and tagged in Shopify Customers |

## Rules built in

- Creators and couriers log in with their store customer account. Access needs approval, and it's checked on the server.
- New products are created as drafts and go live only after approval.
- Price on the site = creator's price + uplift (₪25 by default, which pays for free delivery). Commission is taken on the creator's price.
- Each order creates earnings per creator and a delivery. The delivery is auto-assigned to the least-busy courier covering that city.
- Optional daily capacity per creator: their products sell out for the rest of the day when it's reached.
- The creators list in Content → Metaobjects → MB Creator is kept in sync with approvals and profile changes.

## Code

```
src/index.mjs          routes, webhooks, cron
src/shopify.mjs        session tokens, token exchange + refresh, proxy/webhook HMAC, Admin GraphQL (2026-10)
src/logic.mjs          applications, approvals, orders, capacity, couriers, payouts
src/routes/admin.mjs   JSON API for the embedded dashboard
src/routes/proxy.mjs   creator + courier portals (app proxy, Liquid responses)
src/ui/                admin.html (dashboard), portal.mjs/css/js (portals) → scripts/build-ui.mjs → generated.mjs
test/run.mjs           end-to-end test with a mocked Shopify (npm test)
```

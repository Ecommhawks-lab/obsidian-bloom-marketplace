/**
 * Mercado Bloom marketplace — Shopify app on Cloudflare Workers.
 *   /                 embedded admin dashboard (inside Shopify admin, App Bridge)
 *   /admin-api/*      JSON API for the dashboard (session-token auth)
 *   /proxy/*          creator & courier portals on the storefront (app proxy: store/apps/mb/*)
 *   /webhooks         orders/create, app/uninstalled, compliance topics (HMAC-verified)
 *   cron (hourly)     new-day capacity reset, keeps the access token fresh
 */
import { Hono } from 'hono';
import { ensureSchema, makeDb } from './db.mjs';
import { verifyWebhook, getAccessToken, makeAdmin } from './shopify.mjs';
import { processOrder, dailyReset } from './logic.mjs';
import adminApi from './routes/admin.mjs';
import proxy from './routes/proxy.mjs';
import { ADMIN_HTML } from './ui/generated.mjs';

const app = new Hono();

app.use('*', async (c, next) => {
  try { await ensureSchema(c.env); } catch (e) { console.error('schema', e); }
  await next();
});

app.route('/admin-api', adminApi);
app.route('/proxy', proxy);

/* ------------------------------ webhooks ------------------------------ */
app.post('/webhooks', async (c) => {
  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (!(await verifyWebhook(c.env, raw, c.req.header('X-Shopify-Hmac-Sha256') || ''))) return c.text('bad hmac', 401);
  const topic = c.req.header('X-Shopify-Topic') || '';
  const shop = c.req.header('X-Shopify-Shop-Domain') || c.env.SHOP;
  let body = {};
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { /* empty */ }
  try {
    if (topic === 'orders/create') {
      const job = processOrder(c.env, body).catch((e) => console.error('order', e));
      let ctx = null; try { ctx = c.executionCtx; } catch { /* not on Workers (tests) */ }
      if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
    } else if (topic === 'app/uninstalled') {
      await makeDb(c.env).run(`UPDATE mb_shops SET uninstalled_at = datetime('now'), access_token = NULL, refresh_token = NULL WHERE shop = ?`, [shop]);
    }
    // customers/data_request, customers/redact, shop/redact: no customer payment data is stored;
    // order addresses kept for deliveries are removed on redact.
    else if (topic === 'customers/redact') {
      const ids = (body.orders_to_redact || []).map(String);
      for (const id of ids) await makeDb(c.env).run(`UPDATE mb_orders SET address = NULL, phone = NULL, customer_name = NULL WHERE order_id = ?`, [id]);
      for (const id of ids) await makeDb(c.env).run(`UPDATE mb_deliveries SET address = NULL, phone = NULL, customer_name = NULL WHERE order_id = ?`, [id]);
    }
  } catch (e) { console.error('webhook', topic, e); }
  return c.text('ok');
});

/* ------------------------------ embedded admin ------------------------------ */
const ADMIN_PATHS = ['/', '/applications', '/creators', '/products', '/orders', '/payouts', '/couriers', '/settings'];
for (const p of ADMIN_PATHS) {
  app.get(p, (c) => {
    const shop = c.req.query('shop') || c.env.SHOP;
    const html = ADMIN_HTML.replace('%%API_KEY%%', c.env.SHOPIFY_API_KEY || '').replace('%%SHOP%%', shop);
    return c.body(html, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `frame-ancestors https://${shop} https://admin.shopify.com;`,
    });
  });
}

/* ------------------------------ old app URLs ------------------------------ */
// The previous standalone app lived at /signup, /login, /dashboard, /shop, /admin.
// Send anyone with an old link to the right place on the store.
const store = (c, path) => c.redirect(`https://${c.env.SHOP}${path}`, 301);
app.get('/signup', (c) => store(c, '/pages/join-creators'));
app.get('/login', (c) => store(c, `${c.env.PROXY_PREFIX || '/apps/mb'}/creator`));
app.get('/dashboard', (c) => store(c, `${c.env.PROXY_PREFIX || '/apps/mb'}/creator`));
app.get('/shop', (c) => store(c, `${c.env.PROXY_PREFIX || '/apps/mb'}/creator/profile`));
app.get('/admin', (c) => c.redirect(`https://admin.shopify.com/store/${(c.env.SHOP || '').replace('.myshopify.com', '')}/apps`, 302));
app.get('/health', (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await ensureSchema(env); } catch (e) { console.error(e); return; }
      try { await getAccessToken(env); } catch (e) { console.error('token', e.message); return; }
      if (env.APP_URL) { try { await makeAdmin(env).registerWebhooks(env.APP_URL); } catch (e) { console.error('webhooks', e.message); } }
      try { await dailyReset(env); } catch (e) { console.error('reset', e); }
    })());
  },
};
export { app };

/**
 * Obsidian Bloom — multi-tenant vendor marketplace on Cloudflare Workers (Hono).
 * Vendors sign up, publish products attributed to them (Shopify vendor field +
 * custom.vendor_id metafield, created as DRAFT), an admin approves them, and
 * Stripe Connect handles payouts with an earnings ledger fed by an orders webhook.
 * Data lives in Turso (libSQL). See README.
 */
import { Hono } from 'hono';
import { makeDb, ensureSchema } from './db.mjs';
import {
  hashPassword, verifyPassword, issueSession, clearSession, readSession,
  requireVendor, requireAdmin,
} from './auth.mjs';
import { makeShopify } from './shopify.mjs';
import { makeStripe } from './stripe.mjs';

// HTML pages, bundled as text (see wrangler.jsonc "rules").
import loginHtml from './public/login.html';
import signupHtml from './public/signup.html';
import dashboardHtml from './public/dashboard.html';
import shopHtml from './public/shop.html';
import adminHtml from './public/admin.html';

const app = new Hono();
const html = (s) => new Response(s, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const commissionPct = (env) => Number(env.PLATFORM_COMMISSION_PCT || 15);

// Ensure DB schema once per isolate (idempotent CREATE TABLE IF NOT EXISTS).
app.use('*', async (c, next) => {
  try { await ensureSchema(c.env); } catch (e) { console.error('schema init', e); }
  await next();
});

/* ----------------------------- Auth ----------------------------- */
app.post('/auth/signup', async (c) => {
  try {
    const { email, password, business_name, vat } = await c.req.json().catch(() => ({}));
    if (!email || !password || !business_name) return c.json({ ok: false, error: 'Email, password and business name are required.' }, 400);
    if (String(password).length < 8) return c.json({ ok: false, error: 'Password must be at least 8 characters.' }, 400);
    const db = makeDb(c.env);
    const exists = await db.get('SELECT id FROM vendors WHERE email = ?', [String(email).toLowerCase()]);
    if (exists) return c.json({ ok: false, error: 'That email is already registered.' }, 409);
    const info = await db.run(
      'INSERT INTO vendors (email, password_hash, business_name, vat) VALUES (?,?,?,?)',
      [String(email).toLowerCase(), await hashPassword(password), business_name.trim(), (vat || '').trim()]
    );
    await issueSession(c, { role: 'vendor', vid: info.lastInsertRowid });
    return c.json({ ok: true });
  } catch (e) { console.error(e); return c.json({ ok: false, error: String(e.message || e) }, 500); }
});

app.post('/auth/login', async (c) => {
  try {
    const { email, password } = await c.req.json().catch(() => ({}));
    const db = makeDb(c.env);
    const v = await db.get('SELECT * FROM vendors WHERE email = ?', [String(email || '').toLowerCase()]);
    if (!v || !(await verifyPassword(password || '', v.password_hash))) return c.json({ ok: false, error: 'Invalid email or password.' }, 401);
    if (v.status !== 'active') return c.json({ ok: false, error: 'Account is disabled.' }, 403);
    await issueSession(c, { role: 'vendor', vid: v.id });
    return c.json({ ok: true });
  } catch (e) { console.error(e); return c.json({ ok: false, error: String(e.message || e) }, 500); }
});

app.post('/auth/admin-login', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = c.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return c.json({ ok: false, error: 'Admin login is not configured.' }, 400);
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) { await issueSession(c, { role: 'admin' }); return c.json({ ok: true }); }
  return c.json({ ok: false, error: 'Invalid admin credentials.' }, 401);
});

app.post('/auth/logout', (c) => { clearSession(c); return c.json({ ok: true }); });

app.get('/api/me', async (c) => {
  try {
    const s = await readSession(c);
    const stripeEnabled = makeStripe(c.env).enabled;
    if (!s) return c.json({ ok: true, session: null, stripeEnabled });
    if (s.role === 'admin') return c.json({ ok: true, session: { role: 'admin' }, stripeEnabled });
    const db = makeDb(c.env);
    const v = await db.get('SELECT id, email, business_name, vat, stripe_account_id FROM vendors WHERE id = ?', [s.vid]);
    return c.json({ ok: true, session: v ? { role: 'vendor', ...v } : null, stripeEnabled });
  } catch (e) { console.error(e); return c.json({ ok: false, error: String(e.message || e) }, 500); }
});

/* --------------------------- Vendor: products --------------------------- */
app.post('/api/publish', requireVendor(), async (c) => {
  try {
    const db = makeDb(c.env);
    const vendor = await db.get('SELECT * FROM vendors WHERE id = ?', [c.get('vendorId')]);
    const body = await c.req.parseBody();
    const name = (body.name || '').toString().trim();
    if (!name) return c.json({ ok: false, error: 'Bouquet name is required.' }, 400);
    const price = (body.price || '0').toString().trim();

    let file = null;
    const f = body.image;
    if (f && typeof f === 'object' && typeof f.arrayBuffer === 'function') {
      file = { name: f.name, type: f.type, size: f.size, bytes: new Uint8Array(await f.arrayBuffer()) };
    }

    const result = await makeShopify(c.env).createVendorProduct({
      vendor, name, narrative: (body.narrative || '').toString().trim(),
      price, stem: (body.stem_density || '').toString().trim(), file,
    });

    await db.run(
      'INSERT INTO products (vendor_id, shopify_product_id, shopify_product_gid, title, price, status) VALUES (?,?,?,?,?,?)',
      [vendor.id, result.id, result.gid, name, (Number(price) || 0).toFixed(2), 'pending']
    );
    return c.json({ ok: true, ...result });
  } catch (e) { console.error(e); return c.json({ ok: false, error: String(e.message || e) }, 500); }
});

app.get('/api/my-products', requireVendor(), async (c) => {
  try {
    const db = makeDb(c.env);
    const rows = await db.all('SELECT id, title, price, status, created_at FROM products WHERE vendor_id = ? ORDER BY id DESC', [c.get('vendorId')]);
    return c.json({ ok: true, products: rows });
  } catch (e) { console.error(e); return c.json({ ok: false, error: String(e.message || e) }, 500); }
});

/* --------------------------- Vendor: earnings / insights --------------------------- */
app.get('/api/my-earnings', requireVendor(), async (c) => {
  try {
    const db = makeDb(c.env);
    const vid = c.get('vendorId');
    const sum = await db.get(`
      SELECT
        COALESCE(SUM(net_cents),0)                                                              total,
        COALESCE(SUM(CASE WHEN paid_out = 0 THEN net_cents ELSE 0 END),0)                        owed,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now','-7 days')   THEN net_cents END),0)  week,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now','-30 days')  THEN net_cents END),0)  month,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now','-182 days') THEN net_cents END),0)  sixmo,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now','start of year') THEN net_cents END),0) ytd,
        COUNT(*) orders, MAX(currency) currency
      FROM earnings WHERE vendor_id = ?`, [vid]);
    const recent = await db.all(
      `SELECT order_id, gross_cents, net_cents, currency, paid_out, created_at
       FROM earnings WHERE vendor_id = ? ORDER BY id DESC LIMIT 6`, [vid]);
    const counts = await db.get(
      `SELECT COUNT(*) listed,
              COALESCE(SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END),0) approved,
              COALESCE(SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END),0) pending
       FROM products WHERE vendor_id = ?`, [vid]);
    const currency = (sum && sum.currency) || 'usd';
    return c.json({
      ok: true,
      commission: commissionPct(c.env),
      currency,
      summary: {
        total: sum.total, owed: sum.owed, week: sum.week, month: sum.month,
        sixmo: sum.sixmo, ytd: sum.ytd, orders: sum.orders,
      },
      counts,
      recent,
    });
  } catch (e) { console.error(e); return c.json({ ok: false, error: String(e.message || e) }, 500); }
});

/* --------------------------- Vendor: merchant identity --------------------------- */
app.post('/api/merchant', requireVendor(), async (c) => {
  try {
    const { business_name, vat } = await c.req.json().catch(() => ({}));
    const db = makeDb(c.env);
    await db.run(
      'UPDATE vendors SET business_name = COALESCE(?, business_name), vat = COALESCE(?, vat) WHERE id = ?',
      [business_name ? business_name.trim() : null, vat != null ? vat.trim() : null, c.get('vendorId')]
    );
    return c.json({ ok: true });
  } catch (e) { console.error(e); return c.json({ ok: false, error: String(e.message || e) }, 500); }
});

/* --------------------------- Vendor: Stripe Connect --------------------------- */
app.post('/api/stripe/connect', requireVendor(), async (c) => {
  try {
    const stripe = makeStripe(c.env);
    if (!stripe.enabled) return c.json({ ok: false, error: 'Stripe is not configured on the server.' }, 400);
    const db = makeDb(c.env);
    const vendor = await db.get('SELECT * FROM vendors WHERE id = ?', [c.get('vendorId')]);
    const acctId = await stripe.ensureAccount(vendor);
    if (acctId !== vendor.stripe_account_id) await db.run('UPDATE vendors SET stripe_account_id = ? WHERE id = ?', [acctId, vendor.id]);
    const base = new URL(c.req.url).origin;
    const url = await stripe.onboardingLink(acctId, base);
    return c.json({ ok: true, url });
  } catch (e) { console.error(e); return c.json({ ok: false, error: String(e.message || e) }, 500); }
});

app.get('/api/stripe/status', requireVendor(), async (c) => {
  try {
    const stripe = makeStripe(c.env);
    const db = makeDb(c.env);
    const v = await db.get('SELECT stripe_account_id FROM vendors WHERE id = ?', [c.get('vendorId')]);
    return c.json({ ok: true, enabled: stripe.enabled, ...(await stripe.accountStatus(v?.stripe_account_id)) });
  } catch (e) { return c.json({ ok: false, error: String(e.message || e) }, 500); }
});

/* --------------------------- Admin --------------------------- */
app.get('/api/admin/products', requireAdmin(), async (c) => {
  try {
    const db = makeDb(c.env);
    const rows = await db.all(`
      SELECT p.id, p.title, p.price, p.status, p.shopify_product_id, p.created_at, v.business_name, v.email
      FROM products p JOIN vendors v ON v.id = p.vendor_id ORDER BY p.id DESC`);
    return c.json({ ok: true, products: rows });
  } catch (e) { console.error(e); return c.json({ ok: false, error: String(e.message || e) }, 500); }
});

app.post('/api/admin/products/:id/:action', requireAdmin(), async (c) => {
  try {
    const { id, action } = c.req.param();
    const db = makeDb(c.env);
    const row = await db.get('SELECT * FROM products WHERE id = ?', [id]);
    if (!row) return c.json({ ok: false, error: 'Not found.' }, 404);
    const shopify = makeShopify(c.env);
    if (action === 'approve') {
      await shopify.setProductStatus(row.shopify_product_gid, 'ACTIVE');
      await db.run('UPDATE products SET status = ? WHERE id = ?', ['approved', id]);
    } else if (action === 'reject') {
      await shopify.setProductStatus(row.shopify_product_gid, 'DRAFT');
      await db.run('UPDATE products SET status = ? WHERE id = ?', ['rejected', id]);
    } else return c.json({ ok: false, error: 'Unknown action.' }, 400);
    return c.json({ ok: true });
  } catch (e) { console.error(e); return c.json({ ok: false, error: String(e.message || e) }, 500); }
});

app.get('/api/admin/earnings', requireAdmin(), async (c) => {
  try {
    const db = makeDb(c.env);
    const rows = await db.all(`
      SELECT v.id vendor_id, v.business_name, v.email, v.stripe_account_id,
             COALESCE(SUM(CASE WHEN e.paid_out=0 THEN e.net_cents ELSE 0 END),0) owed_cents,
             COALESCE(SUM(e.net_cents),0) total_cents, e.currency
      FROM vendors v LEFT JOIN earnings e ON e.vendor_id = v.id
      GROUP BY v.id ORDER BY owed_cents DESC`);
    return c.json({ ok: true, vendors: rows, commission: commissionPct(c.env) });
  } catch (e) { console.error(e); return c.json({ ok: false, error: String(e.message || e) }, 500); }
});

app.post('/api/admin/payout/:vendorId', requireAdmin(), async (c) => {
  try {
    const stripe = makeStripe(c.env);
    if (!stripe.enabled) return c.json({ ok: false, error: 'Stripe not configured.' }, 400);
    const db = makeDb(c.env);
    const v = await db.get('SELECT * FROM vendors WHERE id = ?', [c.req.param('vendorId')]);
    if (!v?.stripe_account_id) return c.json({ ok: false, error: 'Vendor has not connected Stripe.' }, 400);
    const agg = await db.get("SELECT COALESCE(SUM(net_cents),0) owed, currency FROM earnings WHERE vendor_id = ? AND paid_out = 0", [v.id]);
    if (!agg.owed) return c.json({ ok: false, error: 'Nothing owed.' }, 400);
    await stripe.payout(v.stripe_account_id, agg.owed, agg.currency || 'usd');
    await db.run('UPDATE earnings SET paid_out = 1 WHERE vendor_id = ? AND paid_out = 0', [v.id]);
    return c.json({ ok: true, paid_cents: agg.owed });
  } catch (e) { console.error(e); return c.json({ ok: false, error: String(e.message || e) }, 500); }
});

/* --------------------------- Shopify orders webhook --------------------------- */
async function hmacOk(secret, rawBytes, headerB64) {
  if (!secret) return true; // no secret configured → skip verification
  if (!headerB64) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, rawBytes);
  let bin = '';
  const arr = new Uint8Array(sig);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  const digest = btoa(bin);
  if (digest.length !== headerB64.length) return false;
  let diff = 0;
  for (let i = 0; i < digest.length; i++) diff |= digest.charCodeAt(i) ^ headerB64.charCodeAt(i);
  return diff === 0;
}

app.post('/webhooks/orders', async (c) => {
  try {
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const ok = await hmacOk(c.env.SHOPIFY_WEBHOOK_SECRET || '', raw, c.req.header('X-Shopify-Hmac-Sha256') || '');
    if (!ok) return c.text('bad hmac', 401);
    const order = JSON.parse(new TextDecoder().decode(raw));
    const currency = (order.currency || 'usd').toLowerCase();
    const db = makeDb(c.env);
    const perVendor = {};
    for (const li of order.line_items || []) {
      const pid = li.product_id ? String(li.product_id) : null;
      if (!pid) continue;
      const prod = await db.get('SELECT vendor_id FROM products WHERE shopify_product_id = ?', [pid]);
      if (!prod) continue;
      const cents = Math.round(Number(li.price) * 100) * Number(li.quantity || 1);
      perVendor[prod.vendor_id] = (perVendor[prod.vendor_id] || 0) + cents;
    }
    const pct = commissionPct(c.env);
    for (const [vid, gross] of Object.entries(perVendor)) {
      const commission = Math.round(gross * (pct / 100));
      await db.run(
        `INSERT OR IGNORE INTO earnings (vendor_id, order_id, gross_cents, commission_cents, net_cents, currency)
         VALUES (?,?,?,?,?,?)`,
        [Number(vid), String(order.id), gross, commission, gross - commission, currency]
      );
    }
    return c.text('ok', 200);
  } catch (e) { console.error('webhook', e); return c.text('ok', 200); } // 200 so Shopify doesn't retry-storm
});

/* --------------------------- Pages --------------------------- */
app.get('/', async (c) => {
  const s = await readSession(c);
  if (s?.role === 'admin') return c.redirect('/admin');
  if (s?.role === 'vendor') return c.redirect('/dashboard');
  return c.redirect('/login');
});
app.get('/login', () => html(loginHtml));
app.get('/signup', () => html(signupHtml));
app.get('/dashboard', async (c) => {
  const s = await readSession(c);
  if (s?.role !== 'vendor') return c.redirect('/login');
  return html(dashboardHtml);
});
app.get('/shop', async (c) => {
  const s = await readSession(c);
  if (s?.role !== 'vendor') return c.redirect('/login');
  return html(shopHtml);
});
app.get('/admin', async (c) => {
  const s = await readSession(c);
  if (s?.role !== 'admin') return c.redirect('/login');
  return html(adminHtml);
});

export default app;

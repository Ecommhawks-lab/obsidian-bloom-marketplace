/**
 * Obsidian Bloom — multi-tenant vendor marketplace (one Shopify store).
 * Vendors sign up, publish products attributed to them (Shopify vendor field +
 * custom.vendor_id metafield, created as DRAFT), an admin approves them, and
 * Stripe Connect handles payouts with an earnings ledger fed by an orders webhook.
 * Data is stored in Turso (libSQL) so it persists on free hosting. See README.md.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { get, all, run, initDb } from './db.mjs';
import { hashPassword, verifyPassword, issue, clear, requireVendor, requireAdmin, readSession } from './auth.mjs';
import { createVendorProduct, setProductStatus, SHOP } from './shopify.mjs';
import { stripeEnabled, ensureAccount, onboardingLink, accountStatus, payout } from './stripe_helper.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8890;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const COMMISSION = Number(process.env.PLATFORM_COMMISSION_PCT || 15);
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || '';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Raw body only for the webhook (needed for HMAC), JSON elsewhere.
app.use('/webhooks/orders', express.raw({ type: '*/*' }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

/* ----------------------------- Auth ----------------------------- */
app.post('/auth/signup', async (req, res) => {
  try {
    const { email, password, business_name, vat } = req.body || {};
    if (!email || !password || !business_name) return res.status(400).json({ ok: false, error: 'Email, password and business name are required.' });
    if (String(password).length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
    const exists = await get('SELECT id FROM vendors WHERE email = ?', [String(email).toLowerCase()]);
    if (exists) return res.status(409).json({ ok: false, error: 'That email is already registered.' });
    const info = await run('INSERT INTO vendors (email, password_hash, business_name, vat) VALUES (?,?,?,?)',
      [String(email).toLowerCase(), hashPassword(password), business_name.trim(), (vat || '').trim()]);
    issue(res, { role: 'vendor', vid: info.lastInsertRowid });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const v = await get('SELECT * FROM vendors WHERE email = ?', [String(email || '').toLowerCase()]);
    if (!v || !verifyPassword(password || '', v.password_hash)) return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
    if (v.status !== 'active') return res.status(403).json({ ok: false, error: 'Account is disabled.' });
    issue(res, { role: 'vendor', vid: v.id });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.post('/auth/admin-login', (req, res) => {
  const { email, password } = req.body || {};
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return res.status(400).json({ ok: false, error: 'Admin login is not configured.' });
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) { issue(res, { role: 'admin' }); return res.json({ ok: true }); }
  res.status(401).json({ ok: false, error: 'Invalid admin credentials.' });
});

app.post('/auth/logout', (req, res) => { clear(res); res.json({ ok: true }); });

app.get('/api/me', async (req, res) => {
  try {
    const s = readSession(req);
    if (!s) return res.json({ ok: true, session: null });
    if (s.role === 'admin') return res.json({ ok: true, session: { role: 'admin' } });
    const v = await get('SELECT id, email, business_name, vat, stripe_account_id FROM vendors WHERE id = ?', [s.vid]);
    res.json({ ok: true, session: v ? { role: 'vendor', ...v } : null, stripeEnabled });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

/* --------------------------- Vendor: products --------------------------- */
app.post('/api/publish', requireVendor, upload.single('image'), async (req, res) => {
  try {
    const vendor = await get('SELECT * FROM vendors WHERE id = ?', [req.vendorId]);
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Bouquet name is required.' });
    const price = (req.body.price || '0').trim();

    const result = await createVendorProduct({
      vendor, name, narrative: (req.body.narrative || '').trim(),
      price, stem: (req.body.stem_density || '').trim(), file: req.file,
    });

    await run('INSERT INTO products (vendor_id, shopify_product_id, shopify_product_gid, title, price, status) VALUES (?,?,?,?,?,?)',
      [vendor.id, result.id, result.gid, name, Number(price || 0).toFixed(2), 'pending']);

    res.json({ ok: true, ...result });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.get('/api/my-products', requireVendor, async (req, res) => {
  try {
    const rows = await all('SELECT id, title, price, status, created_at FROM products WHERE vendor_id = ? ORDER BY id DESC', [req.vendorId]);
    res.json({ ok: true, products: rows });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

/* --------------------------- Vendor: merchant identity --------------------------- */
app.post('/api/merchant', requireVendor, async (req, res) => {
  try {
    const { business_name, vat } = req.body || {};
    await run('UPDATE vendors SET business_name = COALESCE(?, business_name), vat = COALESCE(?, vat) WHERE id = ?',
      [business_name ? business_name.trim() : null, vat != null ? vat.trim() : null, req.vendorId]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

/* --------------------------- Vendor: Stripe Connect --------------------------- */
app.post('/api/stripe/connect', requireVendor, async (req, res) => {
  try {
    if (!stripeEnabled) return res.status(400).json({ ok: false, error: 'Stripe is not configured on the server.' });
    const vendor = await get('SELECT * FROM vendors WHERE id = ?', [req.vendorId]);
    const acctId = await ensureAccount(vendor);
    if (acctId !== vendor.stripe_account_id) await run('UPDATE vendors SET stripe_account_id = ? WHERE id = ?', [acctId, vendor.id]);
    const url = await onboardingLink(acctId, BASE_URL);
    res.json({ ok: true, url });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.get('/api/stripe/status', requireVendor, async (req, res) => {
  try {
    const v = await get('SELECT stripe_account_id FROM vendors WHERE id = ?', [req.vendorId]);
    res.json({ ok: true, enabled: stripeEnabled, ...(await accountStatus(v.stripe_account_id)) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

/* --------------------------- Admin --------------------------- */
app.get('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const rows = await all(`
      SELECT p.id, p.title, p.price, p.status, p.shopify_product_id, p.created_at, v.business_name, v.email
      FROM products p JOIN vendors v ON v.id = p.vendor_id ORDER BY p.id DESC`);
    res.json({ ok: true, products: rows });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.post('/api/admin/products/:id/:action', requireAdmin, async (req, res) => {
  try {
    const { id, action } = req.params;
    const row = await get('SELECT * FROM products WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ ok: false, error: 'Not found.' });
    if (action === 'approve') {
      await setProductStatus(row.shopify_product_gid, 'ACTIVE');
      await run('UPDATE products SET status = ? WHERE id = ?', ['approved', id]);
    } else if (action === 'reject') {
      await setProductStatus(row.shopify_product_gid, 'DRAFT');
      await run('UPDATE products SET status = ? WHERE id = ?', ['rejected', id]);
    } else return res.status(400).json({ ok: false, error: 'Unknown action.' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.get('/api/admin/earnings', requireAdmin, async (req, res) => {
  try {
    const rows = await all(`
      SELECT v.id vendor_id, v.business_name, v.email, v.stripe_account_id,
             COALESCE(SUM(CASE WHEN e.paid_out=0 THEN e.net_cents ELSE 0 END),0) owed_cents,
             COALESCE(SUM(e.net_cents),0) total_cents, e.currency
      FROM vendors v LEFT JOIN earnings e ON e.vendor_id = v.id
      GROUP BY v.id ORDER BY owed_cents DESC`);
    res.json({ ok: true, vendors: rows, commission: COMMISSION });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.post('/api/admin/payout/:vendorId', requireAdmin, async (req, res) => {
  try {
    if (!stripeEnabled) return res.status(400).json({ ok: false, error: 'Stripe not configured.' });
    const v = await get('SELECT * FROM vendors WHERE id = ?', [req.params.vendorId]);
    if (!v?.stripe_account_id) return res.status(400).json({ ok: false, error: 'Vendor has not connected Stripe.' });
    const agg = await get("SELECT COALESCE(SUM(net_cents),0) owed, currency FROM earnings WHERE vendor_id = ? AND paid_out = 0", [v.id]);
    if (!agg.owed) return res.status(400).json({ ok: false, error: 'Nothing owed.' });
    await payout(v.stripe_account_id, agg.owed, agg.currency || 'usd');
    await run('UPDATE earnings SET paid_out = 1 WHERE vendor_id = ? AND paid_out = 0', [v.id]);
    res.json({ ok: true, paid_cents: agg.owed });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

/* --------------------------- Shopify orders webhook --------------------------- */
app.post('/webhooks/orders', async (req, res) => {
  try {
    if (WEBHOOK_SECRET) {
      const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
      const digest = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.body).digest('base64');
      if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(digest))) return res.status(401).send('bad hmac');
    }
    const order = JSON.parse(req.body.toString('utf8'));
    const currency = (order.currency || 'usd').toLowerCase();
    const perVendor = {}; // vendor_id -> gross cents
    for (const li of order.line_items || []) {
      const pid = li.product_id ? String(li.product_id) : null;
      if (!pid) continue;
      const prod = await get('SELECT vendor_id FROM products WHERE shopify_product_id = ?', [pid]);
      if (!prod) continue;
      const cents = Math.round(Number(li.price) * 100) * Number(li.quantity || 1);
      perVendor[prod.vendor_id] = (perVendor[prod.vendor_id] || 0) + cents;
    }
    for (const [vid, gross] of Object.entries(perVendor)) {
      const commission = Math.round(gross * (COMMISSION / 100));
      await run(`INSERT OR IGNORE INTO earnings (vendor_id, order_id, gross_cents, commission_cents, net_cents, currency)
                 VALUES (?,?,?,?,?,?)`,
        [Number(vid), String(order.id), gross, commission, gross - commission, currency]);
    }
    res.status(200).send('ok');
  } catch (e) { console.error('webhook', e); res.status(200).send('ok'); } // 200 so Shopify doesn't retry-storm
});

/* --------------------------- Pages --------------------------- */
app.get('/', (req, res) => {
  const s = readSession(req);
  if (s?.role === 'admin') return res.redirect('/admin');
  if (s?.role === 'vendor') return res.redirect('/dashboard');
  res.redirect('/login');
});
app.get('/login', (_r, s) => s.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup', (_r, s) => s.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/dashboard', (req, res) => {
  if (readSession(req)?.role !== 'vendor') return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/admin', (req, res) => {
  if (readSession(req)?.role !== 'admin') return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

// Create tables, then start listening.
initDb()
  .then(() => app.listen(PORT, () => console.log(`Obsidian Bloom marketplace: ${BASE_URL}  (shop: ${SHOP}, stripe: ${stripeEnabled ? 'on' : 'off'})`)))
  .catch((e) => { console.error('Failed to initialize database:', e); process.exit(1); });

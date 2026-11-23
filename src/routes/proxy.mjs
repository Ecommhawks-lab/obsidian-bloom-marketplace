// Storefront routes behind the Shopify app proxy (store.com/apps/mb/* → worker /proxy/*).
// Every request is signed by Shopify; the logged-in customer id comes from that signature,
// so access to the creator / courier areas is enforced here, on the server.
import { Hono } from 'hono';
import { makeDb, categoryList } from '../db.mjs';
import { verifyProxy, makeAdmin } from '../shopify.mjs';
import { makeStripe } from '../stripe.mjs';
import {
  submitApplication, remainingToday, applyCapacity, creatorStats, setDeliveryStatus, owed, vehicleList,
} from '../logic.mjs';
import * as V from '../ui/portal.mjs';

const proxy = new Hono();
const J = (s, d = null) => { try { return JSON.parse(s || 'null') ?? d; } catch { return d; } };
const liquid = (c, html) => c.body(html, 200, { 'Content-Type': 'application/liquid; charset=utf-8' });
// App proxy responses must be pages, not 30x: send a tiny page that moves the browser on.
const go = (c, url) => liquid(c, `<p style="padding:24px"><a href="${V.esc(url)}">המשך</a></p><script>location.replace(${JSON.stringify(url)})</script>`);
const jfail = (c, e, code = 400) => c.json({ ok: false, error: String(e?.message || e) }, code);

proxy.use('*', async (c, next) => {
  const p = await verifyProxy(c.env, c.req.url);
  if (!p) return c.text('Unauthorized', 401);
  c.set('px', p);
  await next();
});

/* ------------------------------ who is this customer? ------------------------------ */
async function resolve(c, kind) {
  const px = c.get('px');
  if (!px.customerId) return { state: 'login' };
  const db = makeDb(c.env);
  const table = kind === 'creator' ? 'mb_creators' : 'mb_couriers';
  let row = await db.get(`SELECT * FROM ${table} WHERE customer_id = ?`, [px.customerId]);
  if (!row) {
    // First visit after approval, or a legacy account: link by the customer's email.
    let email = '';
    try { email = (await makeAdmin(c.env).customer(px.customerId))?.email?.toLowerCase() || ''; } catch (e) { console.error(e); }
    if (email) {
      row = await db.get(`SELECT * FROM ${table} WHERE email = ?`, [email]);
      if (row) await db.run(`UPDATE ${table} SET customer_id = ? WHERE id = ?`, [px.customerId, row.id]);
    }
    if (!row) {
      const app = email && await db.get(`SELECT status, note FROM mb_applications WHERE kind = ? AND email = ? ORDER BY id DESC LIMIT 1`, [kind, email]);
      return { state: app ? app.status : 'none', note: app?.note || '' };
    }
  }
  if (row.status !== 'approved') return { state: 'suspended' };
  return { state: 'ok', row };
}
function ctxOf(c, extra = {}) {
  const px = c.get('px');
  return { prefix: px.prefix, shopDomain: c.env.SHOP, ...extra };
}
async function gate(c, kind) {
  const r = await resolve(c, kind);
  if (r.state === 'ok') return r.row;
  const ctx = ctxOf(c);
  return liquid(c, r.state === 'login' ? V.loginPage(ctx, kind) : V.statusPage(ctx, kind, r.state, r.note));
}
async function apiGate(c, kind) {
  const r = await resolve(c, kind);
  if (r.state !== 'ok') { c.res = c.json({ ok: false, error: r.state === 'login' ? 'יש להתחבר מחדש' : 'אין הרשאה' }, 403); return null; }
  return r.row;
}
async function stripeState(env, acct) {
  const s = makeStripe(env);
  if (!s.enabled) return { enabled: false };
  try { return { enabled: true, ...(await s.accountStatus(acct)) }; } catch { return { enabled: true, connected: !!acct }; }
}
async function cityList(env) {
  try {
    const d = await makeAdmin(env).gql(`{ metaobjectByHandle(handle: { type: "mb_city_list", handle: "all" }) { field(key: "cities") { value } } }`);
    const lines = String(d.metaobjectByHandle?.field?.value || '').split('\n').map((l) => l.split('|')[0].trim()).filter(Boolean);
    if (lines.length) return lines;
  } catch (e) { console.error('cities', e); }
  return ['תל אביב יפו', 'ירושלים', 'חיפה', 'ראשון לציון', 'פתח תקווה', 'אשדוד', 'נתניה', 'באר שבע'];
}

/* ------------------------------ public: applications ------------------------------ */
proxy.post('/api/upload-target', async (c) => {
  const { files = [] } = await c.req.json().catch(() => ({}));
  const list = files.slice(0, 8).filter((f) => /^image\//.test(f.type || '') && Number(f.size || 0) < 20 * 1024 * 1024);
  if (!list.length) return jfail(c, 'רק קבצי תמונה עד 20MB');
  try { return c.json({ ok: true, targets: await makeAdmin(c.env).stagedTargets(list) }); } catch (e) { return jfail(c, e, 500); }
});
// Private documents for applications (ID, licence, business registration). Kept in the app database,
// never on a public URL; only the store owner can open them in the admin app.
const DOC_TYPES = ['business_doc', 'id_image', 'license_front', 'license_back'];
const DOC_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;
proxy.post('/api/apply-doc', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const type = String(b.doc_type || '');
  const mime = String(b.mime || '').toLowerCase();
  const data = String(b.data || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!DOC_TYPES.includes(type)) return jfail(c, 'סוג מסמך לא מוכר');
  if (!DOC_MIME.test(mime)) return jfail(c, 'אפשר להעלות תמונה (JPG, PNG) או PDF');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return jfail(c, 'הקובץ לא נקרא, נסו שוב');
  const size = Math.floor(data.length * 3 / 4);
  if (size < 200) return jfail(c, 'הקובץ ריק');
  if (size > 6 * 1024 * 1024) return jfail(c, 'הקובץ גדול מדי (עד 6MB)');
  const token = crypto.randomUUID();
  const db = makeDb(c.env);
  await db.run('INSERT INTO mb_documents (token, doc_type, name, mime, size, data) VALUES (?,?,?,?,?,?)',
    [token, type, String(b.name || '').slice(0, 120), mime, size, data]);
  return c.json({ ok: true, token });
});
proxy.post('/api/apply/:kind', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let ctx = null; try { ctx = c.executionCtx; } catch { /* tests */ }
  try {
    await submitApplication(c.env, c.req.param('kind'), body, ctx);
    const days = await makeDb(c.env).setting('review_days', '5');
    return c.json({ ok: true, message: `הבקשה התקבלה ותיבדק תוך ${days} ימי עסקים. נעדכן אותך במייל.` });
  } catch (e) { return jfail(c, e); }
});

proxy.get('/', async (c) => {
  const px = c.get('px');
  if (px.customerId) {
    const db = makeDb(c.env);
    if (await db.get(`SELECT id FROM mb_couriers WHERE customer_id = ? AND status='approved'`, [px.customerId])) return go(c, `${px.prefix}/courier`);
  }
  return go(c, `${px.prefix}/creator`);
});

/* ------------------------------ creator pages ------------------------------ */
proxy.get('/creator', async (c) => {
  const cr = await gate(c, 'creator'); if (cr instanceof Response) return cr;
  const db = makeDb(c.env);
  const recent = await db.all(`SELECT o.order_name, o.city, o.created_at, e.net_cents FROM mb_earnings e JOIN mb_orders o ON o.order_id = e.order_id
     WHERE e.creator_id = ? ORDER BY o.created_at DESC LIMIT 6`, [cr.id]);
  const flash = c.req.query('stripe') === 'done' ? '<div class="mbp-banner">פרטי התשלום עודכנו. תודה!</div>' : '';
  return liquid(c, V.creatorDashboard(ctxOf(c, { who: cr.city, flash }), {
    creator: cr, stats: await creatorStats(db, cr.id), remaining: await remainingToday(db, cr), recent,
    stripe: await stripeState(c.env, cr.stripe_account_id),
  }));
});
proxy.get('/creator/products', async (c) => {
  const cr = await gate(c, 'creator'); if (cr instanceof Response) return cr;
  const products = await makeDb(c.env).all(`SELECT * FROM mb_products WHERE creator_id = ? AND status != 'hidden' ORDER BY updated_at DESC`, [cr.id]);
  return liquid(c, V.creatorProducts(ctxOf(c), { products }));
});
async function editorPage(c, id) {
  const cr = await gate(c, 'creator'); if (cr instanceof Response) return cr;
  const db = makeDb(c.env);
  const settings = await db.settings();
  let product = null, media = [];
  if (id) {
    product = await db.get('SELECT * FROM mb_products WHERE id = ? AND creator_id = ?', [id, cr.id]);
    if (!product) return go(c, `${c.get('px').prefix}/creator/products`);
    product.data = J(product.data, {});
    try { media = product.shopify_gid ? await makeAdmin(c.env).productMedia(product.shopify_gid) : []; } catch (e) { console.error(e); }
  }
  const commission = cr.commission_pct != null ? cr.commission_pct : Number(settings.commission_pct);
  return liquid(c, V.productEditor(ctxOf(c, { commission }), { product, media, settings, categories: categoryList(settings) }));
}
proxy.get('/creator/products/new', (c) => editorPage(c, null));
proxy.get('/creator/products/:id', (c) => editorPage(c, Number(c.req.param('id'))));
proxy.get('/creator/orders', async (c) => {
  const cr = await gate(c, 'creator'); if (cr instanceof Response) return cr;
  const db = makeDb(c.env);
  const rows = await db.all(`SELECT o.*, e.net_cents, e.paid_out, d.status delivery_status FROM mb_earnings e
     JOIN mb_orders o ON o.order_id = e.order_id LEFT JOIN mb_deliveries d ON d.order_id = o.order_id
     WHERE e.creator_id = ? ORDER BY o.created_at DESC LIMIT 100`, [cr.id]);
  const orders = rows.map((o) => ({ ...o, items: (J(o.line_items, []) || []).filter((l) => l.creator_id === cr.id) }));
  return liquid(c, V.creatorOrders(ctxOf(c), { orders }));
});
proxy.get('/creator/profile', async (c) => {
  const cr = await gate(c, 'creator'); if (cr instanceof Response) return cr;
  return liquid(c, V.creatorProfile(ctxOf(c), { creator: cr, cities: await cityList(c.env), stripe: await stripeState(c.env, cr.stripe_account_id) }));
});

/* ------------------------------ creator API ------------------------------ */
function parseProduct(b, uplift, categories) {
  const title = String(b.title || '').trim().slice(0, 120);
  if (!title) throw new Error('יש למלא שם מוצר');
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  const stockOf = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : n(v)); // empty = not limited
  let option = null, price = n(b.price), compareAt = n(b.compareAt) || null;
  if (b.option && Array.isArray(b.option.values) && b.option.values.length) {
    const seen = new Set();
    const values = b.option.values.map((v) => ({ name: String(v.name || '').trim().slice(0, 60), price: n(v.price), compareAt: n(v.compareAt) || null, stock: stockOf(v.stock) }))
      .filter((v) => v.name && !seen.has(v.name) && seen.add(v.name));
    if (!values.length) throw new Error('יש להוסיף לפחות ערך אחד לאפשרות');
    if (values.some((v) => !v.price)) throw new Error('לכל ערך צריך מחיר');
    option = { name: String(b.option.name || 'גודל').trim().slice(0, 40) || 'גודל', values };
    price = Math.min(...values.map((v) => v.price));
  } else if (!price) throw new Error('יש למלא מחיר');
  const tags = String(b.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 15);
  const category = categories.includes(b.category) ? b.category : 'אחר';
  const suggest = category === 'אחר' ? String(b.categorySuggest || '').trim().slice(0, 40) : '';
  const description = String(b.description || '').slice(0, 5000);
  const shipping = b.shipping === 'paid' ? 'paid' : 'free';
  const cost = b.cost === '' || b.cost == null ? null : n(b.cost);
  return { title, option, price, compareAt, tags, category, suggest, description, uplift, shipping, cost, stock: option ? null : stockOf(b.stock) };
}
const toHtml = (t) => t.split(/\n{2,}/).map((p) => `<p>${V.esc(p).replace(/\n/g, '<br>')}</p>`).join('');

export async function saveProduct(env, cr, id, b, opts = {}) {
  const db = makeDb(env);
  const s = await db.settings();
  const delivery = Math.max(0, Number(s.uplift_ils) || 0); // delivery cost (₪) per order
  const existing = id ? await db.get('SELECT * FROM mb_products WHERE id = ? AND creator_id = ?', [id, cr.id]) : null;
  if (id && !existing) throw new Error('המוצר לא נמצא');
  const p = parseProduct(b, delivery, categoryList(s));
  // Shipping at checkout is always free for the client.
  // "free": the creator funds delivery, it comes out of their share (site price = creator price).
  // "paid": the client pays delivery inside the product price (site price = creator price + delivery).
  // In both cases uplift = the delivery cost; processOrder uses it to work out the creator's part.
  p.uplift = delivery;
  const live = existing && ['approved', 'edited'].includes(existing.status);
  const media = Array.isArray(b.media) ? b.media.filter((u) => /^https:\/\//.test(u)).slice(0, 10) : null;
  if (!existing && (!media || !media.length)) throw new Error('יש להוסיף לפחות תמונה אחת');
  const add = (v) => (p.shipping === 'paid' ? Number(v) + delivery : Number(v));
  const result = await makeAdmin(env).saveProduct({
    gid: existing?.shopify_gid || null,
    title: p.title, descriptionHtml: toHtml(p.description), vendor: cr.vendor, productType: p.category,
    tags: ['mercado-bloom', `creator:${cr.id}`, p.category, 'משלוח-חינם', ...p.tags],
    status: live ? 'ACTIVE' : 'DRAFT',
    price: add(p.price), compareAt: p.compareAt ? add(p.compareAt) : null,
    option: p.option ? { name: p.option.name, values: p.option.values.map((v) => ({ name: v.name, price: add(v.price), compareAt: v.compareAt ? add(v.compareAt) : null, stock: v.stock })) } : null,
    stock: p.stock,
    files: media, quantity: s.enforce_capacity === '1' ? await remainingToday(db, cr) : 9999,
    metafields: [
      { namespace: 'custom', key: 'creator_id', type: 'single_line_text_field', value: String(cr.id) },
      { namespace: 'custom', key: 'creator_price', type: 'number_decimal', value: String(p.price) },
    ],
  });
  let warning = '';
  // Every product ships free at checkout: keep its variants in the store's default (free) delivery profile.
  try { await makeAdmin(env).setDeliveryMode(result.variantIds, false, delivery); }
  catch (e) { console.error('delivery profile', e); warning = ' (הגדרת המשלוח תושלם על ידינו)'; }
  const status = opts.keepStatus && existing ? existing.status : live ? 'edited' : 'pending';
  const data = JSON.stringify({ description: p.description, category: p.category, categorySuggest: p.suggest, tags: p.tags, price: p.price,
    compareAt: p.compareAt, option: p.option, stock: p.stock, shipping: p.shipping, cost: p.cost, ship_v: 2 });
  if (existing) {
    await db.run(`UPDATE mb_products SET title=?, data=?, creator_price=?, list_price=?, image_url=COALESCE(?, image_url), handle=?, status=?, reject_reason=NULL, updated_at=datetime('now') WHERE id=?`,
      [p.title, data, p.price, add(p.price), result.image, result.handle, status, existing.id]);
    await db.run('UPDATE mb_products SET uplift = ? WHERE id = ?', [p.uplift, existing.id]);
  } else {
    await db.run(`INSERT INTO mb_products (creator_id, shopify_product_id, shopify_gid, handle, title, data, creator_price, list_price, uplift, image_url, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [cr.id, result.id, result.gid, result.handle, p.title, data, p.price, add(p.price), p.uplift, result.image || (media && media[0]) || null, status]);
  }
  return (live ? 'השינויים נשמרו ומופיעים באתר' : 'המוצר נשמר ונשלח לאישור') + warning;
}
// One-time move (cron): products saved as "client pays shipping" before shipping went into the price.
// Re-saves them so the site price includes the delivery cost and checkout shipping is free.
export async function migratePaidShipping(env) {
  const db = makeDb(env);
  if (await db.setting('paid_ship_v2', '')) return 0;
  let n = 0;
  for (const row of await db.all(`SELECT * FROM mb_products WHERE shopify_gid IS NOT NULL AND status != 'rejected'`)) {
    let d; try { d = JSON.parse(row.data || '{}'); } catch { continue; }
    if (d.shipping !== 'paid' || d.ship_v) continue;
    const cr = await db.get('SELECT * FROM mb_creators WHERE id = ?', [row.creator_id]);
    if (!cr) continue;
    try {
      await saveProduct(env, cr, row.id, { title: row.title, description: d.description || '', category: d.category, categorySuggest: d.categorySuggest,
        tags: (d.tags || []).join(', '), price: d.price ?? row.creator_price, compareAt: d.compareAt, option: d.option, stock: d.stock,
        shipping: 'paid', cost: d.cost }, { keepStatus: true });
      n++;
    } catch (e) { console.error('migrate paid shipping', row.id, e); return n; } // retried next hour
  }
  await db.setSetting('paid_ship_v2', new Date().toISOString());
  return n;
}
proxy.post('/api/creator/products', async (c) => {
  const cr = await apiGate(c, 'creator'); if (!cr) return c.res;
  try { return c.json({ ok: true, message: await saveProduct(c.env, cr, null, await c.req.json()) }); } catch (e) { return jfail(c, e); }
});
proxy.post('/api/creator/products/:id', async (c) => {
  const cr = await apiGate(c, 'creator'); if (!cr) return c.res;
  try { return c.json({ ok: true, message: await saveProduct(c.env, cr, Number(c.req.param('id')), await c.req.json()) }); } catch (e) { return jfail(c, e); }
});
proxy.post('/api/creator/products/:id/archive', async (c) => {
  const cr = await apiGate(c, 'creator'); if (!cr) return c.res;
  const db = makeDb(c.env);
  const p = await db.get('SELECT * FROM mb_products WHERE id = ? AND creator_id = ?', [c.req.param('id'), cr.id]);
  if (!p) return jfail(c, 'המוצר לא נמצא', 404);
  try {
    if (p.shopify_gid) await makeAdmin(c.env).setStatus(p.shopify_gid, 'DRAFT');
    await db.run(`UPDATE mb_products SET status='hidden', updated_at=datetime('now') WHERE id=?`, [p.id]);
    return c.json({ ok: true });
  } catch (e) { return jfail(c, e); }
});
proxy.post('/api/creator/profile', async (c) => {
  const cr = await apiGate(c, 'creator'); if (!cr) return c.res;
  const db = makeDb(c.env);
  const b = await c.req.json().catch(() => ({}));
  const admin = makeAdmin(c.env);
  try {
    let logoUrl = cr.logo_url, logoFile = cr.logo_file_id;
    if (b.logo_resource && /^https:\/\//.test(b.logo_resource)) {
      const f = await admin.createFile(b.logo_resource, cr.name);
      logoFile = f.id; logoUrl = f.image?.url || logoUrl;
      if (!f.image?.url) { // processed asynchronously; try once more shortly after
        await new Promise((r) => setTimeout(r, 1500));
        logoUrl = (await admin.fileUrl(f.id).catch(() => null)) || logoUrl;
      }
    }
    let bannerUrl = cr.banner_url, bannerFile = cr.banner_file_id;
    if (b.banner_resource && /^https:\/\//.test(b.banner_resource)) {
      const f = await admin.createFile(b.banner_resource, cr.name);
      bannerFile = f.id; bannerUrl = f.image?.url || bannerUrl;
      if (!f.image?.url) {
        await new Promise((r) => setTimeout(r, 1500));
        bannerUrl = (await admin.fileUrl(f.id).catch(() => null)) || bannerUrl;
      }
    }
    const capacity = Math.max(0, Math.min(500, parseInt(b.capacity_daily, 10) || 0));
    await db.run(`UPDATE mb_creators SET city=?, bio=?, instagram=?, capacity_daily=?, logo_url=?, logo_file_id=?, banner_url=?, banner_file_id=?, promo=? WHERE id=?`,
      [String(b.city || cr.city || '').slice(0, 60), String(b.bio || '').slice(0, 600), String(b.instagram || '').slice(0, 200), capacity, logoUrl, logoFile,
       bannerUrl, bannerFile, String(b.promo || '').slice(0, 60), cr.id]);
    const fresh = await db.get('SELECT * FROM mb_creators WHERE id = ?', [cr.id]);
    try { await admin.upsertCreatorEntry(fresh, true); } catch (e) { console.error(e); }
    if (capacity !== cr.capacity_daily) await applyCapacity(c.env, cr.id).catch((e) => console.error(e));
    return c.json({ ok: true, message: 'נשמר', reload: true });
  } catch (e) { return jfail(c, e); }
});
async function stripeConnect(c, kind, row) {
  const stripe = makeStripe(c.env);
  if (!stripe.enabled) throw new Error('תשלומים אוטומטיים עדיין לא הופעלו');
  const acct = await stripe.ensureAccount({ email: row.email, name: row.name, stripe_account_id: row.stripe_account_id });
  if (acct !== row.stripe_account_id) await makeDb(c.env).run(`UPDATE ${kind === 'creator' ? 'mb_creators' : 'mb_couriers'} SET stripe_account_id = ? WHERE id = ?`, [acct, row.id]);
  return stripe.onboardingLink(acct, `https://${c.env.SHOP}${c.get('px').prefix}/${kind}`);
}
proxy.post('/api/creator/stripe', async (c) => {
  const cr = await apiGate(c, 'creator'); if (!cr) return c.res;
  try { return c.json({ ok: true, url: await stripeConnect(c, 'creator', cr) }); } catch (e) { return jfail(c, e); }
});

/* ------------------------------ courier ------------------------------ */
async function withPickups(db, list) {
  const names = Object.fromEntries((await db.all('SELECT id, name, city, phone FROM mb_creators')).map((r) => [r.id, r]));
  for (const d of list) {
    const o = await db.get('SELECT creator_ids FROM mb_orders WHERE order_id = ?', [d.order_id]);
    d.address = J(d.address, {});
    d.pickups = (J(o?.creator_ids, []) || []).map((id) => names[id]).filter(Boolean);
  }
  return list;
}
proxy.get('/courier', async (c) => {
  const k = await gate(c, 'courier'); if (k instanceof Response) return k;
  const db = makeDb(c.env);
  k.areas = J(k.areas, []);
  const open = await withPickups(db, await db.all(`SELECT * FROM mb_deliveries WHERE courier_id = ? AND status IN ('assigned','picked_up','failed') ORDER BY id`, [k.id]));
  const today = (await db.get(`SELECT COUNT(*) n FROM mb_deliveries WHERE courier_id = ? AND status='delivered' AND delivered_at >= date('now')`, [k.id])).n;
  const month = (await db.get(`SELECT COUNT(*) n FROM mb_deliveries WHERE courier_id = ? AND status='delivered' AND delivered_at >= date('now','start of month')`, [k.id])).n;
  return liquid(c, V.courierDashboard(ctxOf(c, { who: k.areas.slice(0, 4).join(', ') }), {
    courier: k, open, stats: { today, month, owed: await owed(db, 'courier', k.id) }, stripe: await stripeState(c.env, k.stripe_account_id),
  }));
});
proxy.get('/courier/history', async (c) => {
  const k = await gate(c, 'courier'); if (k instanceof Response) return k;
  const db = makeDb(c.env);
  const done = await withPickups(db, await db.all(`SELECT * FROM mb_deliveries WHERE courier_id = ? AND status='delivered' ORDER BY delivered_at DESC LIMIT 50`, [k.id]));
  return liquid(c, V.courierHistory(ctxOf(c), { done }));
});
proxy.get('/courier/profile', async (c) => {
  const k = await gate(c, 'courier'); if (k instanceof Response) return k;
  k.areas = J(k.areas, []); k.availability = J(k.availability, {});
  return liquid(c, V.courierProfile(ctxOf(c), { courier: k, cities: await cityList(c.env) }));
});
proxy.post('/api/courier/deliveries/:id', async (c) => {
  const k = await apiGate(c, 'courier'); if (!k) return c.res;
  const { status } = await c.req.json().catch(() => ({}));
  try { return c.json(await setDeliveryStatus(c.env, Number(c.req.param('id')), status, k.id)); } catch (e) { return jfail(c, e); }
});
proxy.post('/api/courier/profile', async (c) => {
  const k = await apiGate(c, 'courier'); if (!k) return c.res;
  const b = await c.req.json().catch(() => ({}));
  const areas = (Array.isArray(b.areas) ? b.areas : []).map(String).slice(0, 250);
  const availability = { days: Array.isArray(b.days) ? b.days : [], from: String(b.from || ''), to: String(b.to || '') };
  const vehicles = vehicleList(b.vehicles);
  if (Array.isArray(b.vehicles) && !vehicles.length) return jfail(c, 'יש לבחור לפחות כלי רכב אחד');
  await makeDb(c.env).run('UPDATE mb_couriers SET areas = ?, availability = ?, phone = ?, vehicle = ? WHERE id = ?',
    [JSON.stringify(areas), JSON.stringify(availability), String(b.phone || k.phone || '').slice(0, 30), vehicles.length ? vehicles.join(', ') : (k.vehicle || ''), k.id]);
  return c.json({ ok: true, message: 'נשמר' });
});
proxy.post('/api/courier/stripe', async (c) => {
  const k = await apiGate(c, 'courier'); if (!k) return c.res;
  try { return c.json({ ok: true, url: await stripeConnect(c, 'courier', k) }); } catch (e) { return jfail(c, e); }
});

export default proxy;

// JSON API for the embedded admin dashboard. Every call carries the Shopify
// session token (App Bridge) in "Authorization: Bearer <id_token>".
import { Hono } from 'hono';
import { makeDb, DEFAULT_SETTINGS } from '../db.mjs';
import { verifySessionToken, ensureOfflineToken, makeAdmin } from '../shopify.mjs';
import { makeStripe } from '../stripe.mjs';
import {
  decideApplication, setCreatorStatus, applyCapacity, assignDelivery, setDeliveryStatus,
  payout, owed, creatorStats, autoAssign,
} from '../logic.mjs';

const api = new Hono();
const J = (s) => { try { return JSON.parse(s || 'null'); } catch { return null; } };
const fail = (c, e, code = 400) => c.json({ ok: false, error: String(e?.message || e) }, code);

api.use('*', async (c, next) => {
  const auth = c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return fail(c, 'Missing session token', 401);
  let s;
  try { s = await verifySessionToken(c.env, token); } catch (e) { return fail(c, 'Invalid session: ' + e.message, 401); }
  try {
    const fresh = await ensureOfflineToken(c.env, s.shop, token);
    if (fresh) {
      // First open after install (or re-auth): subscribe orders/create + app/uninstalled.
      // Safe to repeat: existing subscriptions to this URL are skipped.
      const job = makeAdmin(c.env, s.shop).registerWebhooks(new URL(c.req.url).origin)
        .catch((e) => console.error('webhooks', e.message));
      let ctx = null; try { ctx = c.executionCtx; } catch { /* tests */ }
      if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
    }
  } catch (e) { return fail(c, 'Could not authorise with Shopify: ' + e.message, 401); }
  c.set('shop', s.shop);
  await next();
});

api.get('/overview', async (c) => {
  const db = makeDb(c.env);
  const one = (sql, a = []) => db.get(sql, a);
  const [apps, prods, orders, owedC, owedK, active, unassigned, creators, couriers] = await Promise.all([
    one(`SELECT COUNT(*) n FROM mb_applications WHERE status='pending'`),
    one(`SELECT COUNT(*) n FROM mb_products WHERE status IN ('pending','edited')`),
    one(`SELECT COUNT(*) n FROM mb_orders WHERE created_at >= datetime('now','-1 day')`),
    one(`SELECT COALESCE(SUM(net_cents),0) n FROM mb_earnings WHERE paid_out=0`),
    one(`SELECT COALESCE(SUM(fee_cents),0) n FROM mb_deliveries WHERE status='delivered' AND paid_out=0`),
    one(`SELECT COUNT(*) n FROM mb_deliveries WHERE status IN ('assigned','picked_up')`),
    one(`SELECT COUNT(*) n FROM mb_deliveries WHERE status='unassigned'`),
    one(`SELECT COUNT(*) n FROM mb_creators WHERE status='approved'`),
    one(`SELECT COUNT(*) n FROM mb_couriers WHERE status='approved'`),
  ]);
  const sales = await db.get(`SELECT COALESCE(SUM(gross_cents),0) gross, COALESCE(SUM(commission_cents),0) commission FROM mb_earnings WHERE created_at >= datetime('now','-30 days')`);
  const recent = await db.all(`SELECT order_id, order_name, city, customer_name, total, created_at FROM mb_orders ORDER BY created_at DESC LIMIT 8`);
  return c.json({ ok: true, counts: {
    applications: apps.n, products: prods.n, orders24h: orders.n, owedCreators: owedC.n, owedCouriers: owedK.n,
    activeDeliveries: active.n, unassigned: unassigned.n, creators: creators.n, couriers: couriers.n,
  }, sales30: sales, recent, stripe: makeStripe(c.env).enabled, shop: c.get('shop') });
});

/* ---------------- applications ---------------- */
api.get('/applications', async (c) => {
  const db = makeDb(c.env);
  const { kind = '', status = 'pending' } = c.req.query();
  const rows = await db.all(
    `SELECT * FROM mb_applications WHERE (? = '' OR kind = ?) AND (? = 'all' OR status = ?) ORDER BY id DESC LIMIT 200`,
    [kind, kind, status, status]);
  return c.json({ ok: true, applications: rows.map((r) => ({ ...r, data: J(r.data) || {}, images: J(r.images) || [] })) });
});
api.post('/applications/:id/:action', async (c) => {
  const { id, action } = c.req.param();
  const { note = '' } = await c.req.json().catch(() => ({}));
  if (!['approve', 'reject'].includes(action)) return fail(c, 'Unknown action');
  try { return c.json(await decideApplication(c.env, Number(id), action === 'approve', note)); } catch (e) { return fail(c, e); }
});

/* ---------------- creators ---------------- */
api.get('/creators', async (c) => {
  const db = makeDb(c.env);
  const rows = await db.all(`
    SELECT cr.*,
      (SELECT COUNT(*) FROM mb_products p WHERE p.creator_id = cr.id AND p.status IN ('approved','edited')) live,
      (SELECT COUNT(*) FROM mb_products p WHERE p.creator_id = cr.id AND p.status = 'pending') pending,
      (SELECT COALESCE(SUM(net_cents),0) FROM mb_earnings e WHERE e.creator_id = cr.id AND e.paid_out = 0) owed_cents,
      (SELECT COALESCE(SUM(net_cents),0) FROM mb_earnings e WHERE e.creator_id = cr.id) total_cents
    FROM mb_creators cr ORDER BY cr.name`);
  return c.json({ ok: true, creators: rows });
});
api.get('/creators/:id', async (c) => {
  const db = makeDb(c.env);
  const id = Number(c.req.param('id'));
  const creator = await db.get('SELECT * FROM mb_creators WHERE id = ?', [id]);
  if (!creator) return fail(c, 'Not found', 404);
  const products = await db.all('SELECT id, title, status, creator_price, list_price, image_url, handle, updated_at FROM mb_products WHERE creator_id = ? ORDER BY id DESC', [id]);
  const payouts = await db.all(`SELECT * FROM mb_payouts WHERE party='creator' AND party_id = ? ORDER BY id DESC LIMIT 20`, [id]);
  const earnings = await db.all('SELECT * FROM mb_earnings WHERE creator_id = ? ORDER BY id DESC LIMIT 30', [id]);
  return c.json({ ok: true, creator, stats: await creatorStats(db, id), products, payouts, earnings });
});
api.post('/creators/:id', async (c) => {
  const db = makeDb(c.env);
  const id = Number(c.req.param('id'));
  const b = await c.req.json().catch(() => ({}));
  const cur = await db.get('SELECT * FROM mb_creators WHERE id = ?', [id]);
  if (!cur) return fail(c, 'Not found', 404);
  try {
    if (b.status && b.status !== cur.status) await setCreatorStatus(c.env, id, b.status === 'approved' ? 'approved' : 'suspended');
    const capacity = b.capacity_daily != null ? Math.max(0, parseInt(b.capacity_daily, 10) || 0) : cur.capacity_daily;
    const commission = b.commission_pct === '' || b.commission_pct == null ? null : Number(b.commission_pct);
    await db.run('UPDATE mb_creators SET capacity_daily = ?, commission_pct = ?, city = COALESCE(?, city) WHERE id = ?',
      [capacity, commission, b.city ?? null, id]);
    if (capacity !== cur.capacity_daily) await applyCapacity(c.env, id);
    if (b.city != null && b.city !== cur.city) {
      const fresh = await db.get('SELECT * FROM mb_creators WHERE id = ?', [id]);
      await makeAdmin(c.env).upsertCreatorEntry(fresh, fresh.status === 'approved');
    }
    return c.json({ ok: true });
  } catch (e) { return fail(c, e); }
});

/* ---------------- products ---------------- */
api.get('/products', async (c) => {
  const db = makeDb(c.env);
  const { status = 'review' } = c.req.query();
  const where = status === 'review' ? `p.status IN ('pending','edited')` : status === 'all' ? '1=1' : 'p.status = ?';
  const rows = await db.all(
    `SELECT p.*, cr.name creator_name, cr.vendor FROM mb_products p JOIN mb_creators cr ON cr.id = p.creator_id
     WHERE ${where} ORDER BY p.updated_at DESC LIMIT 200`, status === 'review' || status === 'all' ? [] : [status]);
  return c.json({ ok: true, products: rows.map((r) => ({ ...r, data: J(r.data) || {} })) });
});
api.post('/products/:id/:action', async (c) => {
  const db = makeDb(c.env);
  const { id, action } = c.req.param();
  const { reason = '' } = await c.req.json().catch(() => ({}));
  const p = await db.get('SELECT p.*, cr.status creator_status, cr.email FROM mb_products p JOIN mb_creators cr ON cr.id = p.creator_id WHERE p.id = ?', [id]);
  if (!p) return fail(c, 'Not found', 404);
  const admin = makeAdmin(c.env);
  try {
    if (action === 'approve') {
      if (p.creator_status !== 'approved') return fail(c, 'The creator is suspended.');
      await admin.setStatus(p.shopify_gid, 'ACTIVE');
      await db.run(`UPDATE mb_products SET status='approved', reject_reason=NULL, updated_at=datetime('now') WHERE id=?`, [id]);
      await applyCapacity(c.env, p.creator_id).catch((e) => console.error(e));
    } else if (action === 'reject' || action === 'hide') {
      await admin.setStatus(p.shopify_gid, 'DRAFT');
      await db.run(`UPDATE mb_products SET status=?, reject_reason=?, updated_at=datetime('now') WHERE id=?`, [action === 'reject' ? 'rejected' : 'hidden', reason, id]);
    } else return fail(c, 'Unknown action');
    return c.json({ ok: true });
  } catch (e) { return fail(c, e); }
});

/* ---------------- orders & earnings ---------------- */
api.get('/orders', async (c) => {
  const db = makeDb(c.env);
  const rows = await db.all(`
    SELECT o.*, d.status delivery_status, d.courier_id, k.name courier_name
    FROM mb_orders o LEFT JOIN mb_deliveries d ON d.order_id = o.order_id LEFT JOIN mb_couriers k ON k.id = d.courier_id
    ORDER BY o.created_at DESC LIMIT 200`);
  const names = Object.fromEntries((await db.all('SELECT id, name FROM mb_creators')).map((r) => [r.id, r.name]));
  return c.json({ ok: true, orders: rows.map((o) => ({ ...o, line_items: J(o.line_items) || [], creators: (J(o.creator_ids) || []).map((i) => names[i] || i) })) });
});
api.get('/earnings', async (c) => {
  const db = makeDb(c.env);
  const creators = await db.all(`
    SELECT cr.id, cr.name, cr.email, cr.stripe_account_id,
      COALESCE(SUM(CASE WHEN e.paid_out=0 THEN e.net_cents ELSE 0 END),0) owed_cents,
      COALESCE(SUM(e.net_cents),0) total_cents, COALESCE(SUM(e.commission_cents),0) commission_cents, COUNT(e.id) orders
    FROM mb_creators cr LEFT JOIN mb_earnings e ON e.creator_id = cr.id GROUP BY cr.id ORDER BY owed_cents DESC`);
  const couriers = await db.all(`
    SELECT k.id, k.name, k.email, k.stripe_account_id,
      COALESCE(SUM(CASE WHEN d.status='delivered' AND d.paid_out=0 THEN d.fee_cents ELSE 0 END),0) owed_cents,
      COALESCE(SUM(CASE WHEN d.status='delivered' THEN d.fee_cents ELSE 0 END),0) total_cents,
      COALESCE(SUM(CASE WHEN d.status='delivered' THEN 1 ELSE 0 END),0) delivered
    FROM mb_couriers k LEFT JOIN mb_deliveries d ON d.courier_id = k.id GROUP BY k.id ORDER BY owed_cents DESC`);
  const payouts = await db.all(`SELECT p.*, CASE p.party WHEN 'creator' THEN (SELECT name FROM mb_creators WHERE id=p.party_id) ELSE (SELECT name FROM mb_couriers WHERE id=p.party_id) END name
    FROM mb_payouts p ORDER BY p.id DESC LIMIT 50`);
  return c.json({ ok: true, creators, couriers, payouts, stripe: makeStripe(c.env).enabled });
});
api.post('/payout', async (c) => {
  const { party, id, method = 'manual', reference = '' } = await c.req.json().catch(() => ({}));
  if (!['creator', 'courier'].includes(party)) return fail(c, 'Unknown party');
  try { return c.json(await payout(c.env, party, Number(id), method === 'stripe' ? 'stripe' : 'manual', reference)); } catch (e) { return fail(c, e); }
});

/* ---------------- couriers & deliveries ---------------- */
api.get('/couriers', async (c) => {
  const db = makeDb(c.env);
  const rows = await db.all(`SELECT k.*,
      (SELECT COUNT(*) FROM mb_deliveries d WHERE d.courier_id = k.id AND d.status IN ('assigned','picked_up')) active,
      (SELECT COUNT(*) FROM mb_deliveries d WHERE d.courier_id = k.id AND d.status = 'delivered') delivered
    FROM mb_couriers k ORDER BY k.name`);
  for (const r of rows) r.owed_cents = await owed(db, 'courier', r.id);
  return c.json({ ok: true, couriers: rows.map((r) => ({ ...r, areas: J(r.areas) || [], availability: J(r.availability) || {} })) });
});
api.post('/couriers/:id', async (c) => {
  const db = makeDb(c.env);
  const id = Number(c.req.param('id'));
  const b = await c.req.json().catch(() => ({}));
  const cur = await db.get('SELECT * FROM mb_couriers WHERE id = ?', [id]);
  if (!cur) return fail(c, 'Not found', 404);
  const fee = b.fee_ils === '' || b.fee_ils == null ? null : Number(b.fee_ils);
  const areas = Array.isArray(b.areas) ? JSON.stringify(b.areas) : cur.areas;
  const status = b.status === 'suspended' ? 'suspended' : b.status === 'approved' ? 'approved' : cur.status;
  await db.run('UPDATE mb_couriers SET fee_ils = ?, areas = ?, status = ? WHERE id = ?', [fee, areas, status, id]);
  if (status !== cur.status) {
    try {
      const a = makeAdmin(c.env);
      if (status === 'approved') await a.tagCustomer({ email: cur.email }, ['courier-approved'], ['courier-suspended']);
      else await a.tagCustomer({ email: cur.email }, ['courier-suspended'], ['courier-approved']);
    } catch (e) { console.error(e); }
  }
  return c.json({ ok: true });
});
api.get('/deliveries', async (c) => {
  const db = makeDb(c.env);
  const { status = 'open' } = c.req.query();
  const where = status === 'open' ? `d.status IN ('unassigned','assigned','picked_up','failed')` : status === 'all' ? '1=1' : 'd.status = ?';
  const rows = await db.all(`SELECT d.*, k.name courier_name FROM mb_deliveries d LEFT JOIN mb_couriers k ON k.id = d.courier_id
    WHERE ${where} ORDER BY d.id DESC LIMIT 300`, ['open', 'all'].includes(status) ? [] : [status]);
  return c.json({ ok: true, deliveries: rows.map((r) => ({ ...r, address: J(r.address) || {} })) });
});
api.post('/deliveries/:id/assign', async (c) => {
  const { courier_id } = await c.req.json().catch(() => ({}));
  try {
    if (courier_id === 'auto') {
      const db = makeDb(c.env);
      const d = await db.get('SELECT order_id FROM mb_deliveries WHERE id = ?', [c.req.param('id')]);
      const got = d && await autoAssign(c.env, d.order_id);
      return c.json({ ok: !!got, error: got ? undefined : 'No courier covers this city.' });
    }
    await assignDelivery(c.env, Number(c.req.param('id')), courier_id ? Number(courier_id) : null);
    return c.json({ ok: true });
  } catch (e) { return fail(c, e); }
});
api.post('/deliveries/:id/status', async (c) => {
  const { status } = await c.req.json().catch(() => ({}));
  if (!['assigned', 'picked_up', 'delivered', 'failed'].includes(status)) return fail(c, 'Unknown status');
  try { return c.json(await setDeliveryStatus(c.env, Number(c.req.param('id')), status)); } catch (e) { return fail(c, e); }
});

/* ---------------- settings ---------------- */
api.get('/settings', async (c) => {
  const s = await makeDb(c.env).settings();
  return c.json({ ok: true, settings: s, env: {
    stripe: makeStripe(c.env).enabled, email: !!(c.env.RESEND_API_KEY && c.env.NOTIFY_FROM), proxy: c.env.PROXY_PREFIX || '/apps/mb', shop: c.get('shop'),
  } });
});
api.post('/settings', async (c) => {
  const db = makeDb(c.env);
  const b = await c.req.json().catch(() => ({}));
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (b[k] === undefined) continue;
    let v = String(b[k]).trim();
    if (['commission_pct', 'uplift_ils', 'courier_fee_ils', 'review_days'].includes(k)) v = String(Math.max(0, Number(v) || 0));
    if (['auto_assign_couriers', 'enforce_capacity', 'weekend_queue'].includes(k)) v = v === '1' || v === 'true' ? '1' : '0';
    await db.setSetting(k, v);
  }
  return c.json({ ok: true });
});
api.post('/resync', async (c) => {
  const db = makeDb(c.env);
  const admin = makeAdmin(c.env);
  const out = { creators: 0, errors: [] };
  for (const cr of await db.all('SELECT * FROM mb_creators')) {
    try {
      const id = await admin.upsertCreatorEntry(cr, cr.status === 'approved');
      await db.run('UPDATE mb_creators SET metaobject_id = ? WHERE id = ?', [id, cr.id]);
      out.creators++;
    } catch (e) { out.errors.push(cr.name + ': ' + e.message); }
  }
  return c.json({ ok: true, ...out });
});

export default api;

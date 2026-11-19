// Business rules shared by the admin dashboard, the portals, webhooks and cron.
import { makeDb, slugify, israelDay, deliveryDay } from './db.mjs';
import { makeAdmin } from './shopify.mjs';
import { makeStripe } from './stripe.mjs';

export const TAGS = {
  creator: { pending: 'creator-pending', approved: 'creator-approved', rejected: 'creator-rejected' },
  courier: { pending: 'courier-pending', approved: 'courier-approved', rejected: 'courier-rejected' },
};
const UNLIMITED = 9999;

/* ------------------------------ email (optional) ------------------------------ */
export async function notify(env, to, subject, html) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_FROM || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.NOTIFY_FROM, to: [to], subject, html }),
    });
    return r.ok;
  } catch { return false; }
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const storeUrl = (env) => `https://${env.SHOP}`;

/* ------------------------------ applications ------------------------------ */
export async function submitApplication(env, kind, body) {
  const db = makeDb(env);
  const email = String(body.email || '').trim().toLowerCase();
  if (!['creator', 'courier'].includes(kind)) throw new Error('Unknown application type.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('כתובת אימייל לא תקינה');
  if (!String(body.name || '').trim()) throw new Error('יש למלא שם מלא');
  if (!body.terms) throw new Error('יש לאשר את התנאים');
  const table = kind === 'creator' ? 'mb_creators' : 'mb_couriers';
  const already = await db.get(`SELECT status FROM ${table} WHERE email = ?`, [email]);
  if (already) throw new Error('כבר קיים חשבון עם האימייל הזה');
  const open = await db.get(`SELECT id FROM mb_applications WHERE kind = ? AND email = ? AND status = 'pending'`, [kind, email]);
  const data = { ...body }; delete data.images; delete data.terms;
  const images = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
  if (open) {
    await db.run(`UPDATE mb_applications SET name=?, phone=?, city=?, data=?, images=? WHERE id=?`,
      [body.name, body.phone || '', body.city || '', JSON.stringify(data), JSON.stringify(images), open.id]);
  } else {
    await db.run(`INSERT INTO mb_applications (kind, email, name, phone, city, data, images) VALUES (?,?,?,?,?,?,?)`,
      [kind, email, body.name, body.phone || '', body.city || '', JSON.stringify(data), JSON.stringify(images)]);
  }
  // Mirror in Shopify Customers so the client sees the applicant with a pending tag.
  try {
    const cid = await makeAdmin(env).tagCustomer({ email, name: body.name, phone: body.phone }, [TAGS[kind].pending]);
    await db.run(`UPDATE mb_applications SET customer_id = ? WHERE kind = ? AND email = ? AND status = 'pending'`, [cid, kind, email]);
  } catch (e) { console.error('tag pending', e); }
  const s = await db.settings();
  await notify(env, s.notify_email, `בקשת הצטרפות חדשה (${kind === 'creator' ? 'יוצר/ת' : 'שליח/ה'}): ${body.name}`,
    `<p dir="rtl">${esc(body.name)} (${esc(email)}) שלח/ה בקשה. לאישור: אפליקציית Mercado Bloom באדמין של Shopify.</p>`);
  return { ok: true };
}

export async function decideApplication(env, id, approve, note = '') {
  const db = makeDb(env);
  const a = await db.get('SELECT * FROM mb_applications WHERE id = ?', [id]);
  if (!a) throw new Error('Application not found.');
  if (a.status !== 'pending') throw new Error('Already decided.');
  const admin = makeAdmin(env);
  const data = JSON.parse(a.data || '{}');
  const t = TAGS[a.kind];
  if (!approve) {
    await db.run(`UPDATE mb_applications SET status='rejected', note=?, decided_at=datetime('now') WHERE id=?`, [note, id]);
    try { await admin.tagCustomer({ email: a.email, name: a.name }, [t.rejected], [t.pending]); } catch (e) { console.error(e); }
    await notify(env, a.email, 'עדכון לגבי בקשת ההצטרפות שלך', `<p dir="rtl">שלום ${esc(a.name)}, לצערנו הבקשה לא אושרה הפעם.${note ? ' ' + esc(note) : ''}</p>`);
    return { ok: true };
  }
  const customerId = await admin.tagCustomer({ email: a.email, name: a.name, phone: a.phone }, [t.approved], [t.pending, t.rejected]);
  if (a.kind === 'creator') {
    const name = String(data.business || a.name).trim();
    let vendor = name;
    if (await db.get('SELECT id FROM mb_creators WHERE vendor = ?', [vendor])) vendor = `${name} (${a.city || id})`;
    const handle = slugify(vendor);
    const r = await db.run(
      `INSERT INTO mb_creators (application_id, customer_id, email, name, vendor, handle, city, phone, instagram, categories, logo_url)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, customerId, a.email, name, vendor, handle, a.city || '', a.phone || '', data.instagram || '',
       JSON.stringify(data.categories || []), (JSON.parse(a.images || '[]')[0]) || null]
    );
    const creator = await db.get('SELECT * FROM mb_creators WHERE id = ?', [r.lastInsertRowid]);
    try {
      const mo = await admin.upsertCreatorEntry(creator, true);
      await db.run('UPDATE mb_creators SET metaobject_id = ? WHERE id = ?', [mo, creator.id]);
    } catch (e) { console.error('metaobject', e); }
  } else {
    await db.run(
      `INSERT INTO mb_couriers (application_id, customer_id, email, name, phone, city, areas, vehicle, license, availability)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, customerId, a.email, a.name, a.phone || '', a.city || '', JSON.stringify(data.areas || []),
       data.vehicle || '', data.license || '', JSON.stringify({ days: data.days || [], from: data.from || '', to: data.to || '' })]
    );
  }
  await db.run(`UPDATE mb_applications SET status='approved', note=?, customer_id=?, decided_at=datetime('now') WHERE id=?`, [note, customerId, id]);
  const area = a.kind === 'creator' ? 'creator' : 'courier';
  await notify(env, a.email, 'הבקשה שלך אושרה – ברוכים הבאים ל-Mercado Bloom',
    `<p dir="rtl">שלום ${esc(a.name)}, הבקשה אושרה! להתחברות לאזור האישי: <a href="${storeUrl(env)}${env.PROXY_PREFIX || '/apps/mb'}/${area}">${storeUrl(env)}${env.PROXY_PREFIX || '/apps/mb'}/${area}</a> (התחברות עם האימייל ${esc(a.email)}).</p>`);
  return { ok: true, customerId };
}

/* ------------------------------ creator status ------------------------------ */
export async function setCreatorStatus(env, creatorId, status) {
  const db = makeDb(env);
  const c = await db.get('SELECT * FROM mb_creators WHERE id = ?', [creatorId]);
  if (!c) throw new Error('Creator not found.');
  const admin = makeAdmin(env);
  await db.run('UPDATE mb_creators SET status = ? WHERE id = ?', [status, creatorId]);
  const live = await db.all(`SELECT shopify_gid FROM mb_products WHERE creator_id = ? AND status IN ('approved','edited')`, [creatorId]);
  for (const p of live) await admin.setStatus(p.shopify_gid, status === 'approved' ? 'ACTIVE' : 'DRAFT');
  try { await admin.upsertCreatorEntry(c, status === 'approved'); } catch (e) { console.error(e); }
  if (c.customer_id) {
    try {
      if (status === 'approved') await admin.tagCustomer({ email: c.email }, [TAGS.creator.approved], ['creator-suspended']);
      else await admin.tagCustomer({ email: c.email }, ['creator-suspended'], [TAGS.creator.approved]);
    } catch (e) { console.error(e); }
  }
}

/* ------------------------------ capacity ------------------------------ */
export async function remainingToday(db, creator) {
  if (!creator.capacity_daily) return UNLIMITED;
  const r = await db.get('SELECT units FROM mb_capacity WHERE creator_id = ? AND day = ?', [creator.id, israelDay()]);
  return Math.max(0, creator.capacity_daily - (r?.units || 0));
}
export async function applyCapacity(env, creatorId) {
  const db = makeDb(env);
  const s = await db.settings();
  const c = await db.get('SELECT * FROM mb_creators WHERE id = ?', [creatorId]);
  if (!c) return;
  const qty = s.enforce_capacity === '1' ? await remainingToday(db, c) : UNLIMITED;
  const gids = (await db.all(`SELECT shopify_gid FROM mb_products WHERE creator_id = ? AND shopify_gid IS NOT NULL AND status != 'rejected'`, [creatorId])).map((r) => r.shopify_gid);
  await makeAdmin(env).setAvailable(gids, qty);
  return qty;
}
export async function dailyReset(env) {
  const db = makeDb(env);
  const today = israelDay();
  if ((await db.setting('capacity_day', '')) === today) return false;
  await db.setSetting('capacity_day', today);
  const limited = await db.all(`SELECT id FROM mb_creators WHERE status = 'approved' AND capacity_daily > 0`);
  for (const c of limited) { try { await applyCapacity(env, c.id); } catch (e) { console.error('reset', c.id, e); } }
  await db.run(`DELETE FROM mb_capacity WHERE day < date('now','-60 days')`);
  return true;
}

/* ------------------------------ orders ------------------------------ */
export async function processOrder(env, order) {
  const db = makeDb(env);
  const orderId = String(order.id);
  if (await db.get('SELECT order_id FROM mb_orders WHERE order_id = ?', [orderId])) return { duplicate: true };
  const s = await db.settings();
  const commissionDefault = Number(s.commission_pct) || 0;
  const perCreator = {};
  const lines = [];
  for (const li of order.line_items || []) {
    if (!li.product_id) continue;
    const p = await db.get('SELECT * FROM mb_products WHERE shopify_product_id = ?', [String(li.product_id)]);
    if (!p) continue;
    const qty = Number(li.quantity || 1);
    const unit = Math.max(0, Number(li.price) - Number(p.uplift || 0)); // creator keeps price minus the delivery uplift
    const cents = Math.round(unit * 100) * qty;
    (perCreator[p.creator_id] ||= { cents: 0, units: 0 });
    perCreator[p.creator_id].cents += cents;
    perCreator[p.creator_id].units += qty;
    lines.push({ title: li.title, variant: li.variant_title || '', qty, creator_id: p.creator_id, product_id: String(li.product_id) });
  }
  const ship = order.shipping_address || order.billing_address || {};
  const city = (ship.city || '').trim();
  const customerName = [ship.first_name, ship.last_name].filter(Boolean).join(' ') || order.customer?.first_name || '';
  await db.run(
    `INSERT OR IGNORE INTO mb_orders (order_id, order_name, city, address, customer_name, phone, note, total, currency, creator_ids, line_items, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, COALESCE(?, datetime('now')))`,
    [orderId, order.name || '', city, JSON.stringify(ship), customerName, ship.phone || order.phone || '', order.note || '',
     String(order.total_price || ''), (order.currency || 'ILS').toLowerCase(), JSON.stringify(Object.keys(perCreator).map(Number)),
     JSON.stringify(lines), order.created_at ? toSqlTime(order.created_at) : null]
  );
  const day = israelDay(order.created_at ? new Date(order.created_at) : new Date());
  for (const [cid, v] of Object.entries(perCreator)) {
    const creator = await db.get('SELECT * FROM mb_creators WHERE id = ?', [cid]);
    const pct = creator?.commission_pct != null ? Number(creator.commission_pct) : commissionDefault;
    const commission = Math.round(v.cents * pct / 100);
    await db.run(
      `INSERT OR IGNORE INTO mb_earnings (creator_id, order_id, order_name, gross_cents, commission_cents, net_cents, currency)
       VALUES (?,?,?,?,?,?,?)`,
      [Number(cid), orderId, order.name || '', v.cents, commission, v.cents - commission, (order.currency || 'ILS').toLowerCase()]
    );
    await db.run(
      `INSERT INTO mb_capacity (creator_id, day, units) VALUES (?,?,?)
       ON CONFLICT(creator_id, day) DO UPDATE SET units = units + excluded.units`, [Number(cid), day, v.units]);
    if (creator?.capacity_daily > 0 && s.enforce_capacity === '1') {
      try { await applyCapacity(env, Number(cid)); } catch (e) { console.error('capacity', e); }
    }
  }
  if (Object.keys(perCreator).length && order.shipping_address) {
    const fee = Math.round((Number(s.courier_fee_ils) || 0) * 100);
    const r = await db.run(
      `INSERT OR IGNORE INTO mb_deliveries (order_id, order_name, city, address, customer_name, phone, note, fee_cents, deliver_on)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [orderId, order.name || '', city, JSON.stringify(ship), customerName, ship.phone || order.phone || '', order.note || '', fee,
       deliveryDay(order.created_at ? new Date(order.created_at) : new Date(), s.weekend_queue !== '0')]
    );
    if (r.changes && s.auto_assign_couriers === '1') await autoAssign(env, orderId);
  }
  return { creators: Object.keys(perCreator).length };
}
function toSqlTime(iso) { const d = new Date(iso); return isNaN(d) ? null : d.toISOString().replace('T', ' ').slice(0, 19); }

/* ------------------------------ couriers ------------------------------ */
const norm = (s) => String(s || '').replace(/["'״׳\-\s]/g, '');
export async function autoAssign(env, orderId) {
  const db = makeDb(env);
  const d = await db.get('SELECT * FROM mb_deliveries WHERE order_id = ?', [orderId]);
  if (!d || d.courier_id) return null;
  const couriers = await db.all(`SELECT * FROM mb_couriers WHERE status = 'approved'`);
  const city = norm(d.city);
  const match = couriers.filter((c) => {
    const areas = JSON.parse(c.areas || '[]').map(norm);
    return city && (areas.includes(city) || norm(c.city) === city);
  });
  if (!match.length) return null;
  const loads = {};
  for (const c of match) {
    const r = await db.get(`SELECT COUNT(*) n FROM mb_deliveries WHERE courier_id = ? AND status IN ('assigned','picked_up')`, [c.id]);
    loads[c.id] = r.n;
  }
  match.sort((a, b) => loads[a.id] - loads[b.id]);
  await assignDelivery(env, d.id, match[0].id);
  return match[0].id;
}
export async function assignDelivery(env, deliveryId, courierId) {
  const db = makeDb(env);
  const c = courierId ? await db.get('SELECT * FROM mb_couriers WHERE id = ?', [courierId]) : null;
  const fee = c?.fee_ils != null ? Math.round(Number(c.fee_ils) * 100) : null;
  await db.run(
    `UPDATE mb_deliveries SET courier_id = ?, status = ?, assigned_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,
       fee_cents = COALESCE(?, fee_cents) WHERE id = ? AND status IN ('unassigned','assigned')`,
    [courierId || null, courierId ? 'assigned' : 'unassigned', courierId || null, fee, deliveryId]
  );
  if (c) {
    const d = await db.get('SELECT * FROM mb_deliveries WHERE id = ?', [deliveryId]);
    await notify(env, c.email, `משלוח חדש: ${d.order_name} (${d.city})`,
      `<p dir="rtl">שובץ לך משלוח חדש. לפרטים: ${storeUrl(env)}${env.PROXY_PREFIX || '/apps/mb'}/courier</p>`);
  }
}
export async function setDeliveryStatus(env, deliveryId, status, courierId = null) {
  const db = makeDb(env);
  const d = await db.get('SELECT * FROM mb_deliveries WHERE id = ?', [deliveryId]);
  if (!d) throw new Error('Delivery not found.');
  if (courierId && d.courier_id !== courierId) throw new Error('This delivery is not assigned to you.');
  const flow = { assigned: ['picked_up', 'failed'], picked_up: ['delivered', 'failed'], failed: ['picked_up'], unassigned: [], delivered: [] };
  if (courierId && !(flow[d.status] || []).includes(status)) throw new Error('Invalid status change.');
  const col = { picked_up: 'picked_at', delivered: 'delivered_at' }[status];
  await db.run(`UPDATE mb_deliveries SET status = ?${col ? `, ${col} = datetime('now')` : ''} WHERE id = ?`, [status, deliveryId]);
  if (status === 'delivered') {
    try { await makeAdmin(env).fulfillOrder(d.order_id); } catch (e) { console.error('fulfill', e); return { ok: true, warning: 'נמסר, אך סימון ההזמנה כ"נשלחה" ב-Shopify נכשל: ' + e.message }; }
  }
  return { ok: true };
}

/* ------------------------------ payouts ------------------------------ */
export async function owed(db, party, id) {
  if (party === 'creator') {
    return (await db.get(`SELECT COALESCE(SUM(net_cents),0) c FROM mb_earnings WHERE creator_id = ? AND paid_out = 0`, [id])).c;
  }
  return (await db.get(`SELECT COALESCE(SUM(fee_cents),0) c FROM mb_deliveries WHERE courier_id = ? AND status = 'delivered' AND paid_out = 0`, [id])).c;
}
export async function payout(env, party, id, method, reference = '') {
  const db = makeDb(env);
  const table = party === 'creator' ? 'mb_creators' : 'mb_couriers';
  const who = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!who) throw new Error('Not found.');
  const amount = await owed(db, party, id);
  if (!amount) throw new Error('Nothing owed.');
  const currency = await db.setting('payout_currency', 'ils');
  if (method === 'stripe') {
    if (!who.stripe_account_id) throw new Error('Stripe is not connected for this account.');
    const t = await makeStripe(env).transfer(who.stripe_account_id, amount, currency, `Mercado Bloom ${party} payout`);
    reference = t.id;
  }
  const r = await db.run(`INSERT INTO mb_payouts (party, party_id, amount_cents, currency, method, reference) VALUES (?,?,?,?,?,?)`,
    [party, id, amount, currency, method, reference]);
  if (party === 'creator') await db.run(`UPDATE mb_earnings SET paid_out = 1, payout_id = ? WHERE creator_id = ? AND paid_out = 0`, [r.lastInsertRowid, id]);
  else await db.run(`UPDATE mb_deliveries SET paid_out = 1, payout_id = ? WHERE courier_id = ? AND status = 'delivered' AND paid_out = 0`, [r.lastInsertRowid, id]);
  return { ok: true, amount_cents: amount, reference };
}

/* ------------------------------ earnings summary ------------------------------ */
export async function creatorStats(db, creatorId) {
  const sum = await db.get(`
    SELECT COALESCE(SUM(net_cents),0) total,
      COALESCE(SUM(CASE WHEN paid_out=0 THEN net_cents ELSE 0 END),0) owed,
      COALESCE(SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN net_cents END),0) week,
      COALESCE(SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN net_cents END),0) month,
      COALESCE(SUM(CASE WHEN created_at >= datetime('now','-182 days') THEN net_cents END),0) sixmo,
      COALESCE(SUM(CASE WHEN created_at >= datetime('now','start of year') THEN net_cents END),0) ytd,
      COUNT(*) orders
    FROM mb_earnings WHERE creator_id = ?`, [creatorId]);
  const counts = await db.get(`SELECT COUNT(*) listed,
      COALESCE(SUM(CASE WHEN status IN ('approved','edited') THEN 1 ELSE 0 END),0) live,
      COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) pending,
      COALESCE(SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END),0) rejected
    FROM mb_products WHERE creator_id = ?`, [creatorId]);
  return { ...sum, ...counts };
}

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

/* ------------------------------ vehicles ------------------------------ */
// From small to large. A courier with a larger vehicle can take a job that needs a smaller one.
export const VEHICLES = ['אופניים', 'קטנוע', 'רכב'];
const vRank = (v) => VEHICLES.indexOf(String(v || '').trim()) + 1; // 0 = unknown
export function vehicleList(raw) {
  if (Array.isArray(raw)) return raw.map(String).map((x) => x.trim()).filter((x) => VEHICLES.includes(x));
  return String(raw || '').split(/[,،\n]/).map((x) => x.trim()).filter((x) => VEHICLES.includes(x));
}
// Settings "vehicle_rules": one "category: vehicle" per line. Returns the largest vehicle needed by the categories.
export function requiredVehicle(settings, categories = []) {
  const rules = {};
  for (const line of String(settings?.vehicle_rules || '').split('\n')) {
    const m = line.split(/[:=]/);
    if (m.length < 2) continue;
    const cat = m[0].trim(), veh = m.slice(1).join(':').trim();
    if (cat && vRank(veh)) rules[cat] = veh;
  }
  let need = '';
  for (const cat of categories) { const v = rules[String(cat || '').trim()]; if (v && vRank(v) > vRank(need)) need = v; }
  return need;
}
export function canCarry(courier, need) {
  if (!need) return true;
  const best = Math.max(0, ...vehicleList(courier?.vehicle).map(vRank));
  return best >= vRank(need);
}

/* ------------------------------ WhatsApp (Meta Cloud API, optional) ------------------------------ */
// Template messages only (business-initiated). Order notifications only, to keep costs low.
export const waReady = (env) => !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID);
export async function sendWhatsApp(env, to, template, lang, params = []) {
  const digits = waDigits(to);
  if (!waReady(env) || !digits || !template) return false;
  const body = { messaging_product: 'whatsapp', to: digits, type: 'template',
    template: { name: template, language: { code: lang || 'he' } } };
  if (params.length) body.template.components = [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t ?? '').replace(/\s+/g, ' ').slice(0, 900) || '-' })) }];
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { console.error('whatsapp', r.status, (await r.text()).slice(0, 300)); return false; }
    return true;
  } catch (e) { console.error('whatsapp', e); return false; }
}

/* ------------------------------ notification emails ------------------------------ */
// Israeli numbers (05x...) -> international digits for wa.me links.
const waDigits = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '972' + d.slice(1); return d; };
const shipLine = (a) => { try { a = typeof a === 'string' ? JSON.parse(a || '{}') : (a || {}); } catch { a = {}; } return [a.address1, a.address2, a.city].filter(Boolean).join(', '); };
const btn = (href, label) => `<a href="${href}" style="display:inline-block;margin:4px 0 4px 8px;padding:10px 16px;border-radius:999px;background:#000;color:#fff;text-decoration:none;font-weight:700">${label}</a>`;
const wrap = (inner) => `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111">${inner}<p style="color:#777;font-size:13px;margin-top:24px">Mercado Bloom</p></div>`;
async function notifyCreatorOrder(env, creator, order, lines, deliverOn, settings) {
  if (!creator?.email && !creator?.phone) return;
  const items = lines.map((l) => `<li>${esc(l.qty)} × ${esc(l.title)}${l.variant && l.variant !== 'Default Title' ? ' (' + esc(l.variant) + ')' : ''}</li>`).join('');
  const s = settings || {};
  if (s.whatsapp_enabled === '1' && creator.phone) {
    await sendWhatsApp(env, creator.phone, s.wa_template_creator, s.wa_lang, [creator.name, order.name || '',
      lines.map((l) => `${l.qty} × ${l.title}${l.variant && l.variant !== 'Default Title' ? ' (' + l.variant + ')' : ''}`).join(', '), deliverOn || 'היום']);
  }
  await notify(env, creator.email, `הזמנה חדשה ${order.name || ''} – יש להכין`, wrap(
    `<p>שלום ${esc(creator.name)}, התקבלה הזמנה חדשה עבורך.</p>
     <p><strong>הזמנה:</strong> ${esc(order.name || '')}<br><strong>להכנה עד:</strong> ${esc(deliverOn || 'היום')}</p>
     <ul>${items}</ul>
     <p>שליח/ה יגיע/תגיע לאסוף מהכתובת שבפרופיל שלך. הפרטים המלאים באזור היוצרים:</p>
     ${btn(`${storeUrl(env)}${env.PROXY_PREFIX || '/apps/mb'}/creator`, 'לאזור היוצרים')}`));
}
async function notifyCourierDelivery(env, db, courier, d) {
  if (!d || (!courier?.email && !courier?.phone)) return;
  const addr = shipLine(d.address);
  const need = d.required_vehicle || '';
  try {
    const s = await db.settings();
    if (s.whatsapp_enabled === '1' && courier.phone) {
      await sendWhatsApp(env, courier.phone, s.wa_template_courier, s.wa_lang, [courier.name, d.order_name || '',
        [d.city, addr].filter(Boolean).join(' – '), need || 'כל כלי רכב', d.deliver_on || 'היום']);
    }
  } catch (e) { console.error('wa courier', e); }
  let pick = [];
  try {
    const o = await db.get('SELECT creator_ids FROM mb_orders WHERE order_id = ?', [d.order_id]);
    const ids = JSON.parse(o?.creator_ids || '[]');
    for (const id of ids) { const c = await db.get('SELECT name, city, phone FROM mb_creators WHERE id = ?', [id]); if (c) pick.push(c); }
  } catch (e) { console.error('pickup', e); }
  const pickHtml = pick.map((c) => `<li>${esc(c.name)}${c.city ? ' – ' + esc(c.city) : ''}${c.phone ? ' · <a href="tel:' + esc(c.phone) + '">' + esc(c.phone) + '</a>' : ''}</li>`).join('');
  const wa = waDigits(d.phone);
  await notify(env, courier.email, `משלוח חדש: ${d.order_name} (${d.city})`, wrap(
    `<p>שלום ${esc(courier.name)}, שובץ לך משלוח חדש.</p>
     <p><strong>הזמנה:</strong> ${esc(d.order_name)}<br><strong>יום מסירה:</strong> ${esc(d.deliver_on || 'היום')}<br>
     <strong>לקוח/ה:</strong> ${esc(d.customer_name)}${d.phone ? ' · <a href="tel:' + esc(d.phone) + '">' + esc(d.phone) + '</a>' : ''}<br>
     <strong>כתובת:</strong> ${esc(addr)}${d.note ? '<br><strong>הערה:</strong> ' + esc(d.note) : ''}</p>
     ${need ? `<p style="padding:10px 14px;border:2px solid #000;border-radius:10px"><strong>חובה להגיע עם: ${esc(need)}</strong> (לפי סוג המוצרים בהזמנה)</p>` : ''}
     ${pickHtml ? '<p><strong>איסוף מ:</strong></p><ul>' + pickHtml + '</ul>' : ''}
     <p>${addr ? btn('https://waze.com/ul?navigate=yes&q=' + encodeURIComponent(addr), 'ניווט ב-Waze') : ''}${wa ? btn('https://wa.me/' + wa, 'וואטסאפ ללקוח/ה') : ''}${btn(`${storeUrl(env)}${env.PROXY_PREFIX || '/apps/mb'}/courier`, 'לאזור השליחים')}</p>`));
}

/* ------------------------------ applications ------------------------------ */
// Israeli ID (teudat zehut): 9 digits with a Luhn-style check digit.
export function validIsraeliId(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (!d || d.length > 9) return false;
  const s = d.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) { let n = Number(s[i]) * ((i % 2) + 1); if (n > 9) n -= 9; sum += n; }
  return sum % 10 === 0 && Number(s) > 0;
}
// Documents each application must include (tokens from /api/apply-doc).
export const DOC_LABELS = { business_doc: 'תעודת עוסק / רישום עסק', id_image: 'צילום תעודת זהות', license_front: 'רישיון נהיגה – צד קדמי', license_back: 'רישיון נהיגה – צד אחורי' };
function requiredDocs(kind, body) {
  if (kind === 'creator') return ['business_doc'];
  const hasLicense = String(body.license || '').trim() && String(body.license).trim() !== 'לא';
  return ['id_image', ...(hasLicense ? ['license_front', 'license_back'] : []), 'business_doc'];
}

export async function submitApplication(env, kind, body, ctx = null) {
  const db = makeDb(env);
  const email = String(body.email || '').trim().toLowerCase();
  if (!['creator', 'courier'].includes(kind)) throw new Error('Unknown application type.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('כתובת אימייל לא תקינה');
  if (!String(body.name || '').trim()) throw new Error('יש למלא שם מלא');
  if (!body.terms) throw new Error('יש לאשר את התנאים');
  if (kind === 'courier') {
    if (!validIsraeliId(body.id_number)) throw new Error('מספר תעודת זהות לא תקין');
    body.id_number = String(body.id_number).replace(/\D/g, '').padStart(9, '0');
    const vehicles = vehicleList(body.vehicles || body.vehicle);
    if (!vehicles.length) throw new Error('יש לבחור לפחות כלי רכב אחד');
    body.vehicles = vehicles; body.vehicle = vehicles.join(', ');
  }
  // Private documents: every required one must be uploaded and not yet used by another application.
  const docs = body.documents && typeof body.documents === 'object' ? body.documents : {};
  const docIds = {};
  for (const t of requiredDocs(kind, body)) {
    const tok = String(docs[t] || '');
    const row = tok && await db.get('SELECT id, doc_type, application_id FROM mb_documents WHERE token = ?', [tok]);
    if (!row || row.doc_type !== t || row.application_id) throw new Error('חסר מסמך: ' + DOC_LABELS[t]);
    docIds[t] = row.id;
  }
  const table = kind === 'creator' ? 'mb_creators' : 'mb_couriers';
  const already = await db.get(`SELECT status FROM ${table} WHERE email = ?`, [email]);
  if (already) throw new Error('כבר קיים חשבון עם האימייל הזה');
  const open = await db.get(`SELECT id FROM mb_applications WHERE kind = ? AND email = ? AND status = 'pending'`, [kind, email]);
  const data = { ...body }; delete data.images; delete data.terms; delete data.documents;
  const images = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
  let appId;
  if (open) {
    await db.run(`UPDATE mb_applications SET name=?, phone=?, city=?, data=?, images=? WHERE id=?`,
      [body.name, body.phone || '', body.city || '', JSON.stringify(data), JSON.stringify(images), open.id]);
    appId = open.id;
  } else {
    const r = await db.run(`INSERT INTO mb_applications (kind, email, name, phone, city, data, images) VALUES (?,?,?,?,?,?,?)`,
      [kind, email, body.name, body.phone || '', body.city || '', JSON.stringify(data), JSON.stringify(images)]);
    appId = r.lastInsertRowid;
  }
  for (const id of Object.values(docIds)) await db.run('UPDATE mb_documents SET application_id = ? WHERE id = ?', [appId, id]);
  // The application is saved. The rest (Shopify customer tag, email) runs after the response,
  // so a slow Shopify call or a closed browser tab can never lose the application.
  const after = (async () => {
    try {
      const cid = await makeAdmin(env).tagCustomer({ email, name: body.name, phone: body.phone }, [TAGS[kind].pending]);
      await db.run(`UPDATE mb_applications SET customer_id = ? WHERE id = ?`, [cid, appId]);
    } catch (e) { console.error('tag pending', e); }
    try {
      const s = await db.settings();
      await notify(env, s.notify_email, `בקשת הצטרפות חדשה (${kind === 'creator' ? 'יוצר/ת' : 'שליח/ה'}): ${body.name}`,
        `<p dir="rtl">${esc(body.name)} (${esc(email)}) שלח/ה בקשה. לאישור: אפליקציית Mercado Bloom באדמין של Shopify.</p>`);
    } catch (e) { console.error('notify', e); }
  })();
  if (ctx?.waitUntil) ctx.waitUntil(after); else await after;
  return { ok: true, id: appId };
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
      `INSERT INTO mb_couriers (application_id, customer_id, email, name, phone, city, areas, vehicle, license, availability, id_number)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, customerId, a.email, a.name, a.phone || '', a.city || '', JSON.stringify(data.areas || []),
       vehicleList(data.vehicles || data.vehicle).join(', '), data.license || '', JSON.stringify({ days: data.days || [], from: data.from || '', to: data.to || '' }),
       data.id_number || null]
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
  const rows = await db.all(`SELECT shopify_gid, data FROM mb_products WHERE creator_id = ? AND shopify_gid IS NOT NULL AND status != 'rejected'`, [creatorId]);
  const stockOf = Object.fromEntries(rows.map((r) => [r.shopify_gid, variantStock(r.data)]));
  // Per variant: the creator's remaining stock (if they set one), capped by today's capacity.
  await makeAdmin(env).setAvailable(rows.map((r) => r.shopify_gid), (gid, title) => {
    const st = stockOf[gid]?.(title);
    return st == null ? qty : Math.min(qty, st);
  });
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

// Creator stock saved with the product: data.stock (single) or data.option.values[].stock.
// Returns fn(variantTitle) => remaining units, or null when not limited.
export function variantStock(raw) {
  let d; try { d = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch { d = {}; }
  const lim = (v) => (v === null || v === undefined || v === '' ? null : Math.max(0, Number(v) || 0));
  return (title) => {
    if (d.option?.values?.length) return lim(d.option.values.find((v) => v.name === title)?.stock);
    return lim(d.stock);
  };
}
async function decrementStock(db, product, variantTitle, qty) {
  let d; try { d = JSON.parse(product.data || '{}'); } catch { return; }
  let changed = false;
  if (d.option?.values?.length) {
    const v = d.option.values.find((x) => x.name === variantTitle);
    if (v && v.stock != null && v.stock !== '') { v.stock = Math.max(0, Number(v.stock) - qty); changed = true; }
  } else if (d.stock != null && d.stock !== '') { d.stock = Math.max(0, Number(d.stock) - qty); changed = true; }
  if (changed) await db.run('UPDATE mb_products SET data = ? WHERE id = ?', [JSON.stringify(d), product.id]);
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
    let mode = null, cat = ''; try { const pd = JSON.parse(p.data || '{}'); mode = pd.shipping || null; cat = pd.category || ''; } catch { /* legacy */ }
    // Checkout shipping is always free. "free": the creator funds delivery (uplift is taken from their share).
    // "paid" and legacy products: the delivery cost (uplift) was added to the site price, so the creator's
    // part is the price minus the uplift. Paid products saved before this change have uplift 0.
    const unit = mode === 'free' ? Number(li.price) : Math.max(0, Number(li.price) - Number(p.uplift || 0));
    const cents = Math.round(unit * 100) * qty;
    (perCreator[p.creator_id] ||= { cents: 0, units: 0, free: false });
    perCreator[p.creator_id].cents += cents;
    perCreator[p.creator_id].units += qty;
    if (mode === 'free') perCreator[p.creator_id].free = Math.max(perCreator[p.creator_id].free || 0, Number(p.uplift || 0));
    lines.push({ title: li.title, variant: li.variant_title || '', qty, creator_id: p.creator_id, product_id: String(li.product_id), category: cat || li.product_type || '' });
    try { await decrementStock(db, p, li.variant_title || 'Default Title', qty); } catch (e) { console.error('stock', e); }
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
  const shippingPaid = Number(order.total_shipping_price_set?.shop_money?.amount ?? order.shipping_lines?.reduce((a, l) => a + Number(l.price || 0), 0) ?? 0) > 0;
  for (const [cid, v] of Object.entries(perCreator)) {
    const creator = await db.get('SELECT * FROM mb_creators WHERE id = ?', [cid]);
    const pct = creator?.commission_pct != null ? Number(creator.commission_pct) : commissionDefault;
    const commission = Math.round(v.cents * pct / 100);
    // Free shipping offered by the creator: the delivery cost comes out of their share (once per order).
    const delivery = v.free && !shippingPaid ? Math.round(v.free * 100) : 0;
    await db.run(
      `INSERT OR IGNORE INTO mb_earnings (creator_id, order_id, order_name, gross_cents, commission_cents, net_cents, currency)
       VALUES (?,?,?,?,?,?,?)`,
      [Number(cid), orderId, order.name || '', v.cents, commission, Math.max(0, v.cents - commission - delivery), (order.currency || 'ILS').toLowerCase()]
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
      `INSERT OR IGNORE INTO mb_deliveries (order_id, order_name, city, address, customer_name, phone, note, fee_cents, deliver_on, required_vehicle)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [orderId, order.name || '', city, JSON.stringify(ship), customerName, ship.phone || order.phone || '', order.note || '', fee,
       deliveryDay(order.created_at ? new Date(order.created_at) : new Date(), s.weekend_queue !== '0'),
       requiredVehicle(s, lines.map((l) => l.category)) || null]
    );
    if (r.changes) {
      const assigned = s.auto_assign_couriers === '1' ? await autoAssign(env, orderId) : null;
      if (!assigned) {
        await notify(env, s.notify_email, `משלוח בלי שליח: ${order.name || ''} (${city || 'ללא עיר'})`, wrap(
          `<p>להזמנה ${esc(order.name || '')} לא נמצא/ה שליח/ה שמכסה את ${esc(city || 'העיר')}${requiredVehicle(s, lines.map((l) => l.category)) ? ' עם ' + esc(requiredVehicle(s, lines.map((l) => l.category))) : ''}. יש לשבץ ידנית באפליקציה: Couriers &amp; deliveries.</p>`));
      }
    }
  }
  // Tell each creator what to prepare (best effort: an email problem never blocks the order).
  const deliverOn = deliveryDay(order.created_at ? new Date(order.created_at) : new Date(), s.weekend_queue !== '0');
  for (const cid of Object.keys(perCreator)) {
    try {
      const creator = await db.get('SELECT id, name, email, phone FROM mb_creators WHERE id = ?', [cid]);
      await notifyCreatorOrder(env, creator, order, lines.filter((l) => String(l.creator_id) === String(cid)), deliverOn, s);
    } catch (e) { console.error('notify creator', e); }
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
  // Covers the city, and has the vehicle the products need (when a rule is set in Settings).
  const match = couriers.filter((c) => {
    const areas = JSON.parse(c.areas || '[]').map(norm);
    return city && (areas.includes(city) || norm(c.city) === city) && canCarry(c, d.required_vehicle);
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
    try { await notifyCourierDelivery(env, db, c, d); } catch (e) { console.error('notify courier', e); }
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

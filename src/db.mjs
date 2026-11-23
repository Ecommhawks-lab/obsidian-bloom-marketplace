// Turso (libSQL) access. One client per request, built from the Worker env.
// Tests inject env.__dbClient (a local file database) instead.
import { createClient } from '@libsql/client/web';

export function makeDb(env) {
  const client = env.__dbClient || createClient({
    url: env.TURSO_DATABASE_URL || '',
    authToken: env.TURSO_AUTH_TOKEN || '',
  });
  const toObj = (columns, row) => {
    const o = {};
    for (let i = 0; i < columns.length; i++) {
      const v = row[i];
      o[columns[i]] = typeof v === 'bigint' ? Number(v) : v;
    }
    return o;
  };
  const db = {
    client,
    async get(sql, args = []) {
      const r = await client.execute({ sql, args });
      return r.rows.length ? toObj(r.columns, r.rows[0]) : null;
    },
    async all(sql, args = []) {
      const r = await client.execute({ sql, args });
      return r.rows.map((row) => toObj(r.columns, row));
    },
    async run(sql, args = []) {
      const r = await client.execute({ sql, args });
      return {
        lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : undefined,
        changes: r.rowsAffected,
      };
    },
    async setting(key, fallback) {
      const r = await db.get('SELECT value FROM mb_settings WHERE key = ?', [key]);
      return r ? r.value : fallback;
    },
    async settings() {
      const rows = await db.all('SELECT key, value FROM mb_settings');
      const out = { ...DEFAULT_SETTINGS };
      for (const r of rows) out[r.key] = r.value;
      return out;
    },
    async setSetting(key, value) {
      await db.run('INSERT INTO mb_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
    },
  };
  return db;
}

export const DEFAULT_SETTINGS = {
  commission_pct: '23',        // platform commission on the creator's price (business plan: 23%)
  uplift_ils: '25',            // delivery cost per product: charged at checkout, or paid by the creator when they offer free shipping
  categories: 'פרחים\nזרים\nעציצים\nפרחים מיובשים\nמתנות\nעיצוב לבית\nקרמיקה\nטקסטיל\nתכשיטים', // one per line; "אחר" is always added
  courier_fee_ils: '25',       // paid to the courier per delivered order
  auto_assign_couriers: '1',   // assign new orders to a courier who covers the city
  enforce_capacity: '1',       // creator products sell out when daily capacity is reached
  payout_currency: 'ils',
  notify_email: '',            // where new applications are announced (needs RESEND_API_KEY)
  review_days: '5',
  weekend_queue: '1',          // Fri/Sat orders are delivered on Sunday (Israeli work week)
  // Product category -> vehicle the courier must come with. One rule per line: "עציצים: רכב".
  // Vehicles from small to large: אופניים < קטנוע < רכב. A courier with a larger vehicle can take a smaller job.
  vehicle_rules: '',
  // WhatsApp order notifications (Meta WhatsApp Cloud API). Needs WHATSAPP_TOKEN + WHATSAPP_PHONE_ID secrets
  // and approved message templates. Only new-order messages are sent, to keep the bill low.
  whatsapp_enabled: '0',
  wa_template_creator: 'mb_new_order',
  wa_template_courier: 'mb_new_delivery',
  wa_lang: 'he',
};

let initialized = false;
export async function ensureSchema(env) {
  if (initialized && !env.__dbClient) return;
  const { client } = makeDb(env);
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS mb_shops (
      shop TEXT PRIMARY KEY,
      access_token TEXT, refresh_token TEXT,
      expires_at INTEGER, refresh_expires_at INTEGER,
      scope TEXT, online_store_pub TEXT, location_id TEXT,
      installed_at TEXT DEFAULT (datetime('now')), uninstalled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS mb_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS mb_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,                 -- creator | courier
      email TEXT NOT NULL, name TEXT, phone TEXT, city TEXT,
      data TEXT, images TEXT,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
      note TEXT, customer_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS mb_creators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER, customer_id TEXT, email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, vendor TEXT UNIQUE NOT NULL, handle TEXT,
      city TEXT, bio TEXT, phone TEXT, instagram TEXT, categories TEXT,
      logo_url TEXT, logo_file_id TEXT,
      capacity_daily INTEGER NOT NULL DEFAULT 0,
      commission_pct REAL,
      stripe_account_id TEXT,
      status TEXT NOT NULL DEFAULT 'approved',  -- approved | suspended
      metaobject_id TEXT, legacy_vendor_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mb_couriers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER, customer_id TEXT, email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, phone TEXT, city TEXT, areas TEXT, vehicle TEXT,
      license TEXT, availability TEXT, fee_ils REAL,
      stripe_account_id TEXT,
      status TEXT NOT NULL DEFAULT 'approved',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mb_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id INTEGER NOT NULL,
      shopify_product_id TEXT, shopify_gid TEXT, handle TEXT,
      title TEXT NOT NULL, data TEXT,
      creator_price REAL, list_price REAL, uplift REAL,
      image_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | edited | hidden
      reject_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mb_orders (
      order_id TEXT PRIMARY KEY, order_name TEXT, city TEXT, address TEXT,
      customer_name TEXT, phone TEXT, note TEXT, total TEXT, currency TEXT,
      creator_ids TEXT, line_items TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mb_earnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id INTEGER NOT NULL, order_id TEXT NOT NULL, order_name TEXT,
      gross_cents INTEGER NOT NULL, commission_cents INTEGER NOT NULL, net_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'ils',
      paid_out INTEGER NOT NULL DEFAULT 0, payout_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (creator_id, order_id)
    );
    CREATE TABLE IF NOT EXISTS mb_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT UNIQUE NOT NULL, order_name TEXT,
      courier_id INTEGER, city TEXT, address TEXT, customer_name TEXT, phone TEXT, note TEXT,
      status TEXT NOT NULL DEFAULT 'unassigned', -- unassigned | assigned | picked_up | delivered | failed
      fee_cents INTEGER NOT NULL DEFAULT 0,
      paid_out INTEGER NOT NULL DEFAULT 0, payout_id INTEGER,
      assigned_at TEXT, picked_at TEXT, delivered_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mb_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party TEXT NOT NULL, party_id INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'ils',
      method TEXT NOT NULL, reference TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mb_capacity (
      creator_id INTEGER NOT NULL, day TEXT NOT NULL, units INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (creator_id, day)
    );
  `);
  // Added after first release: planned delivery day (Fri/Sat orders move to Sunday).
  try { await client.execute('ALTER TABLE mb_deliveries ADD COLUMN deliver_on TEXT'); } catch { /* already there */ }
  // Round 3: vehicle the order needs, courier ID number, private documents uploaded with applications.
  try { await client.execute('ALTER TABLE mb_deliveries ADD COLUMN required_vehicle TEXT'); } catch { /* already there */ }
  try { await client.execute('ALTER TABLE mb_couriers ADD COLUMN id_number TEXT'); } catch { /* already there */ }
  await client.execute(`CREATE TABLE IF NOT EXISTS mb_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,         -- handed to the browser while the form is being filled
      doc_type TEXT NOT NULL,             -- business_doc | id_image | license_front | license_back
      name TEXT, mime TEXT, size INTEGER,
      data TEXT NOT NULL,                 -- base64; private (never on a public URL), shown only in the admin app
      application_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  // Creator store card (Wolt-style): 4:3 cover / promo image and a short promo line.
  for (const col of ['banner_url TEXT', 'banner_file_id TEXT', 'promo TEXT']) {
    try { await client.execute('ALTER TABLE mb_creators ADD COLUMN ' + col); } catch { /* already there */ }
  }
  await migrateLegacy(makeDb(env));
  initialized = true;
}

// One-time copy of the old Obsidian Bloom tables (vendors, products, earnings)
// into the new mb_ tables. Old tables are left untouched.
async function migrateLegacy(db) {
  const done = await db.get("SELECT value FROM mb_settings WHERE key = 'legacy_migrated'");
  if (done) return;
  const hasVendors = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='vendors'");
  if (hasVendors) {
    const vendors = await db.all('SELECT * FROM vendors');
    for (const v of vendors) {
      await db.run(
        `INSERT OR IGNORE INTO mb_creators (email, name, vendor, handle, stripe_account_id, status, legacy_vendor_id)
         VALUES (?,?,?,?,?,?,?)`,
        [v.email, v.business_name, v.business_name, slugify(v.business_name), v.stripe_account_id || null,
         v.status === 'active' ? 'approved' : 'suspended', v.id]
      );
    }
    const hasProducts = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='products'");
    if (hasProducts) {
      const rows = await db.all(`SELECT p.*, c.id cid FROM products p JOIN mb_creators c ON c.legacy_vendor_id = p.vendor_id`);
      for (const p of rows) {
        await db.run(
          `INSERT INTO mb_products (creator_id, shopify_product_id, shopify_gid, title, creator_price, list_price, uplift, status, created_at)
           VALUES (?,?,?,?,?,?,0,?,?)`,
          [p.cid, p.shopify_product_id, p.shopify_product_gid, p.title, Number(p.price) || 0, Number(p.price) || 0,
           p.status === 'approved' ? 'approved' : p.status === 'rejected' ? 'rejected' : 'pending', p.created_at]
        );
      }
    }
    const hasEarn = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='earnings'");
    if (hasEarn) {
      const rows = await db.all(`SELECT e.*, c.id cid FROM earnings e JOIN mb_creators c ON c.legacy_vendor_id = e.vendor_id`);
      for (const e of rows) {
        await db.run(
          `INSERT OR IGNORE INTO mb_earnings (creator_id, order_id, gross_cents, commission_cents, net_cents, currency, paid_out, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [e.cid, e.order_id, e.gross_cents, e.commission_cents, e.net_cents, e.currency || 'ils', e.paid_out, e.created_at]
        );
      }
    }
  }
  await db.setSetting('legacy_migrated', new Date().toISOString());
}

// Admin-managed product categories (Settings). "אחר" (other) is always last.
export function categoryList(settings) {
  const list = String(settings?.categories ?? DEFAULT_SETTINGS.categories).split(/\n|,/).map((x) => x.trim()).filter(Boolean)
    .filter((x) => x !== 'אחר');
  return [...new Set(list), 'אחר'];
}

export function slugify(s) {
  const base = String(s || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return base || 'creator-' + Math.random().toString(36).slice(2, 8);
}

// Israel calendar day (YYYY-MM-DD), used for daily capacity.
// Planned delivery day in Israel: orders placed on Friday or Saturday wait for Sunday.
export function deliveryDay(d = new Date(), weekendQueue = true) {
  const day = israelDay(d);
  if (!weekendQueue) return day;
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' }).format(d);
  const add = wd === 'Fri' ? 2 : wd === 'Sat' ? 1 : 0;
  if (!add) return day;
  const [y, m, dd] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + add)).toISOString().slice(0, 10);
}

export function israelDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

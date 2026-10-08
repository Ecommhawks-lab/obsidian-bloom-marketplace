// Turso (libSQL) access for Cloudflare Workers. The web client is fetch-based,
// so it runs on Workers with no Node APIs. A client is created per request from
// the Worker's `env` bindings (Workers have no process.env).
import { createClient } from '@libsql/client/web';

export function makeDb(env) {
  const client = createClient({
    url: env.TURSO_DATABASE_URL || '',
    authToken: env.TURSO_AUTH_TOKEN || '',
  });

  const toObj = (columns, row) => {
    const o = {};
    for (let i = 0; i < columns.length; i++) o[columns[i]] = row[i];
    return o;
  };

  return {
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
  };
}

// Create tables if they don't exist. Safe to call on every request (cheap,
// idempotent) — but we gate it behind a one-time flag per isolate.
let initialized = false;
export async function ensureSchema(env) {
  if (initialized) return;
  const { client } = makeDb(env);
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      business_name TEXT NOT NULL,
      vat TEXT,
      stripe_account_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL,
      shopify_product_id TEXT,
      shopify_product_gid TEXT,
      title TEXT NOT NULL,
      price TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (vendor_id) REFERENCES vendors(id)
    );
    CREATE TABLE IF NOT EXISTS earnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      gross_cents INTEGER NOT NULL,
      commission_cents INTEGER NOT NULL,
      net_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'usd',
      paid_out INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (vendor_id, order_id),
      FOREIGN KEY (vendor_id) REFERENCES vendors(id)
    );
  `);
  initialized = true;
}

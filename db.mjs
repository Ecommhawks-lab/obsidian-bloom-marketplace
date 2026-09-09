// Turso (libSQL) storage — free, persistent, never expires, survives restarts/redeploys.
// SQLite dialect, so the schema and SQL are unchanged; only the driver is async.
// Set TURSO_DATABASE_URL (libsql://...) and TURSO_AUTH_TOKEN in your environment.
import { createClient } from '@libsql/client/web';

const url = process.env.TURSO_DATABASE_URL || '';
const authToken = process.env.TURSO_AUTH_TOKEN || '';
if (!url) {
  console.warn('[db] TURSO_DATABASE_URL is not set. Create a free database at https://turso.tech and set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.');
}

export const client = createClient({ url, authToken });

// Turn a libSQL result row into a plain object keyed by column name.
function toObj(columns, row) {
  const o = {};
  for (let i = 0; i < columns.length; i++) o[columns[i]] = row[i];
  return o;
}

// Query helpers mirroring the old better-sqlite3 shape (get/all/run), but async.
export async function get(sql, args = []) {
  const r = await client.execute({ sql, args });
  return r.rows.length ? toObj(r.columns, r.rows[0]) : null;
}
export async function all(sql, args = []) {
  const r = await client.execute({ sql, args });
  return r.rows.map((row) => toObj(r.columns, row));
}
export async function run(sql, args = []) {
  const r = await client.execute({ sql, args });
  return {
    lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : undefined,
    changes: r.rowsAffected,
  };
}

// Create tables if they don't exist. Call once at startup.
export async function initDb() {
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
}

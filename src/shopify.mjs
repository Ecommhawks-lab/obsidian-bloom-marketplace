// Shopify app plumbing for Workers: session tokens, token exchange (expiring
// offline tokens + refresh), app proxy and webhook signatures, Admin GraphQL.
import { jwtVerify } from 'jose';
import { makeDb } from './db.mjs';

const enc = new TextEncoder();

/* ------------------------------ signatures ------------------------------ */
async function hmac(secret, data, out = 'hex') {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, typeof data === 'string' ? enc.encode(data) : data));
  if (out === 'hex') return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
  let bin = ''; for (const b of sig) bin += String.fromCharCode(b); return btoa(bin);
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// App proxy: sorted "k=v" pairs (multi values joined by ","), no separator, HMAC hex.
export async function verifyProxy(env, url) {
  const u = new URL(url);
  const sig = u.searchParams.get('signature');
  if (!sig || !env.SHOPIFY_API_SECRET) return null;
  const map = {};
  for (const [k, v] of u.searchParams) { if (k === 'signature') continue; (map[k] ||= []).push(v); }
  const msg = Object.keys(map).map((k) => `${k}=${map[k].join(',')}`).sort().join('');
  const calc = await hmac(env.SHOPIFY_API_SECRET, msg, 'hex');
  if (!safeEqual(calc, sig)) return null;
  const ts = Number(u.searchParams.get('timestamp') || 0);
  if (ts && Math.abs(Date.now() / 1000 - ts) > 60 * 60 * 24) return null; // stale link
  return {
    shop: u.searchParams.get('shop'),
    customerId: u.searchParams.get('logged_in_customer_id') || '',
    prefix: u.searchParams.get('path_prefix') || env.PROXY_PREFIX || '/apps/mb',
  };
}

export async function verifyWebhook(env, rawBytes, header) {
  if (!env.SHOPIFY_API_SECRET || !header) return false; // never skip verification
  return safeEqual(await hmac(env.SHOPIFY_API_SECRET, rawBytes, 'b64'), header);
}

// Embedded admin: id_token (session token) signed HS256 with the client secret.
export async function verifySessionToken(env, token) {
  const { payload } = await jwtVerify(token, enc.encode(env.SHOPIFY_API_SECRET), {
    algorithms: ['HS256'], audience: env.SHOPIFY_API_KEY, clockTolerance: 10,
  });
  const dest = new URL(payload.dest).hostname;
  const iss = new URL(payload.iss).hostname;
  if (dest !== iss) throw new Error('token host mismatch');
  if (env.SHOP && dest !== env.SHOP) throw new Error('this app is installed for ' + env.SHOP + ' only');
  return { shop: dest, userId: payload.sub, payload };
}

/* ------------------------------ tokens ------------------------------ */
async function tokenRequest(shop, body) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error('Token request failed: ' + (json.error_description || json.error || res.status));
  return json;
}
async function saveToken(db, shop, t) {
  const now = Date.now();
  await db.run(
    `INSERT INTO mb_shops (shop, access_token, refresh_token, expires_at, refresh_expires_at, scope, uninstalled_at)
     VALUES (?,?,?,?,?,?,NULL)
     ON CONFLICT(shop) DO UPDATE SET access_token=excluded.access_token, refresh_token=excluded.refresh_token,
       expires_at=excluded.expires_at, refresh_expires_at=excluded.refresh_expires_at, scope=excluded.scope, uninstalled_at=NULL`,
    [shop, t.access_token, t.refresh_token || null,
     t.expires_in ? now + Number(t.expires_in) * 1000 : null,
     t.refresh_token_expires_in ? now + Number(t.refresh_token_expires_in) * 1000 : null,
     t.scope || null]
  );
}

// Called on every embedded request: exchanges the id_token for an expiring
// offline token when we have none (first open after install) or it can't be refreshed.
export async function ensureOfflineToken(env, shop, idToken) {
  const db = makeDb(env);
  const row = await db.get('SELECT * FROM mb_shops WHERE shop = ?', [shop]);
  const usable = row && row.access_token && !row.uninstalled_at &&
    (!row.refresh_expires_at || row.refresh_expires_at > Date.now() + 60_000);
  if (usable) return false;
  const t = await tokenRequest(shop, {
    client_id: env.SHOPIFY_API_KEY, client_secret: env.SHOPIFY_API_SECRET,
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: idToken, subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    expiring: '1',
  });
  await saveToken(db, shop, t);
  return true; // newly installed / re-authorised
}

let refreshing = null;
export async function getAccessToken(env, shop) {
  shop = shop || env.SHOP;
  const db = makeDb(env);
  const row = await db.get('SELECT * FROM mb_shops WHERE shop = ?', [shop]);
  if (!row || !row.access_token || row.uninstalled_at) throw new Error('The app is not installed yet. Open it once from the Shopify admin.');
  if (!row.expires_at || row.expires_at > Date.now() + 120_000) return row.access_token;
  if (!row.refresh_token) return row.access_token;
  // One refresh at a time per isolate: a refresh retires the previous token pair.
  refreshing ||= (async () => {
    try {
      const t = await tokenRequest(shop, {
        client_id: env.SHOPIFY_API_KEY, client_secret: env.SHOPIFY_API_SECRET,
        grant_type: 'refresh_token', refresh_token: row.refresh_token,
      });
      await saveToken(db, shop, t);
      return t.access_token;
    } finally { setTimeout(() => { refreshing = null; }, 0); }
  })();
  return refreshing;
}

/* ------------------------------ GraphQL ------------------------------ */
export function makeAdmin(env, shop) {
  shop = shop || env.SHOP;
  const API = env.API_VERSION || '2026-10';
  const db = makeDb(env);

  async function gql(query, variables = {}) {
    const token = await getAccessToken(env, shop);
    const res = await fetch(`https://${shop}/admin/api/${API}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.errors) throw new Error('Shopify: ' + JSON.stringify(json.errors || res.status).slice(0, 400));
    return json.data;
  }
  const userErr = (r, ...paths) => {
    for (const p of paths) { const e = r?.[p]; if (e && e.length) return e.map((x) => x.message).join('; '); }
    return null;
  };

  async function shopRow() { return db.get('SELECT * FROM mb_shops WHERE shop = ?', [shop]); }

  async function locationId() {
    const row = await shopRow();
    if (row?.location_id) return row.location_id;
    const d = await gql(`{ locations(first: 10, query: "active:true") { nodes { id isActive fulfillsOnlineOrders } } }`);
    const loc = d.locations.nodes.find((l) => l.fulfillsOnlineOrders) || d.locations.nodes[0];
    if (!loc) throw new Error('No active location in the store.');
    await db.run('UPDATE mb_shops SET location_id = ? WHERE shop = ?', [loc.id, shop]);
    return loc.id;
  }

  async function onlineStorePublication() {
    const row = await shopRow();
    if (row?.online_store_pub) return row.online_store_pub;
    const d = await gql(`{ publications(first: 50) { nodes { id name catalog { title } } } }`);
    const nodes = d.publications.nodes;
    const os = nodes.find((p) => /online store/i.test(p.catalog?.title || p.name || ''));
    const id = (os || nodes[0])?.id;
    if (id) await db.run('UPDATE mb_shops SET online_store_pub = ? WHERE shop = ?', [id, shop]);
    return id;
  }

  return {
    shop, gql, locationId, onlineStorePublication,

    async registerWebhooks(appUrl) {
      const topics = ['ORDERS_CREATE', 'APP_UNINSTALLED'];
      const existing = await gql(`{ webhookSubscriptions(first: 50) { nodes { id topic uri } } }`).catch(() => null);
      const have = new Set((existing?.webhookSubscriptions?.nodes || []).filter((n) => (n.uri || '').startsWith(appUrl)).map((n) => n.topic));
      for (const topic of topics) {
        if (have.has(topic)) continue;
        const d = await gql(
          `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
             webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { message } }
           }`,
          { topic, sub: { uri: `${appUrl}/webhooks`, format: 'JSON' } }
        );
        const e = userErr(d.webhookSubscriptionCreate, 'userErrors');
        if (e && !/taken|already/i.test(e)) throw new Error('webhook ' + topic + ': ' + e);
      }
    },

    async stagedTargets(files) {
      const d = await gql(
        `mutation($input: [StagedUploadInput!]!) {
           stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { message } }
         }`,
        { input: files.map((f) => ({ filename: f.name || 'image.jpg', mimeType: f.type || 'image/jpeg', resource: 'IMAGE', httpMethod: 'POST' })) }
      );
      const e = userErr(d.stagedUploadsCreate, 'userErrors'); if (e) throw new Error(e);
      return d.stagedUploadsCreate.stagedTargets;
    },

    async createFile(resourceUrl, alt) {
      const d = await gql(
        `mutation($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus ... on MediaImage { image { url } } } userErrors { message } } }`,
        { files: [{ originalSource: resourceUrl, contentType: 'IMAGE', alt: alt || '' }] }
      );
      const e = userErr(d.fileCreate, 'userErrors'); if (e) throw new Error(e);
      return d.fileCreate.files[0];
    },

    async fileUrl(id) {
      const d = await gql(`query($id: ID!) { node(id: $id) { ... on MediaImage { fileStatus image { url } } } }`, { id });
      return d.node?.image?.url || null;
    },

    // Create or update a creator product. p = { gid?, title, descriptionHtml, vendor, productType,
    // tags, status, option?: {name, values:[{name, price, compareAt}]}, price, compareAt, files?: [url], quantity, metafields }
    async saveProduct(p) {
      const loc = await locationId();
      const qty = [{ locationId: loc, name: 'available', quantity: Math.max(0, p.quantity ?? 9999) }];
      let productOptions, variants;
      if (p.option && p.option.values?.length) {
        productOptions = [{ name: p.option.name, values: p.option.values.map((v) => ({ name: v.name })) }];
        variants = p.option.values.map((v) => ({
          optionValues: [{ optionName: p.option.name, name: v.name }],
          price: money(v.price), ...(v.compareAt ? { compareAtPrice: money(v.compareAt) } : {}),
          inventoryItem: { tracked: true }, inventoryPolicy: 'DENY', inventoryQuantities: qty,
        }));
      } else {
        productOptions = [{ name: 'Title', values: [{ name: 'Default Title' }] }];
        variants = [{
          optionValues: [{ optionName: 'Title', name: 'Default Title' }],
          price: money(p.price), ...(p.compareAt ? { compareAtPrice: money(p.compareAt) } : {}),
          inventoryItem: { tracked: true }, inventoryPolicy: 'DENY', inventoryQuantities: qty,
        }];
      }
      const input = {
        title: p.title, descriptionHtml: p.descriptionHtml || '', vendor: p.vendor,
        productType: p.productType || '', status: p.status || 'DRAFT', tags: p.tags || [],
        productOptions, variants, metafields: p.metafields || [],
      };
      if (p.files) input.files = p.files.map((f) => ({ originalSource: f, contentType: 'IMAGE', alt: p.title }));
      const d = await gql(
        `mutation($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
           productSet(input: $input, identifier: $identifier, synchronous: true) {
             product { id handle status featuredMedia { preview { image { url } } } }
             userErrors { field message }
           }
         }`,
        { input, identifier: p.gid ? { id: p.gid } : null }
      );
      const e = userErr(d.productSet, 'userErrors'); if (e) throw new Error(e);
      const prod = d.productSet.product;
      return { gid: prod.id, id: prod.id.split('/').pop(), handle: prod.handle, image: prod.featuredMedia?.preview?.image?.url || null };
    },

    async productMedia(gid) {
      const d = await gql(`query($id: ID!) { product(id: $id) { media(first: 20) { nodes { ... on MediaImage { id image { url } } } } } }`, { id: gid });
      return (d.product?.media?.nodes || []).filter((n) => n.image).map((n) => n.image.url);
    },

    async setStatus(gid, status) {
      const d = await gql(
        `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { message } } }`,
        { product: { id: gid, status } }
      );
      const e = userErr(d.productUpdate, 'userErrors'); if (e) throw new Error(e);
      if (status === 'ACTIVE') {
        const pub = await onlineStorePublication();
        if (pub) {
          const p = await gql(
            `mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`,
            { id: gid, input: [{ publicationId: pub }] }
          );
          const pe = userErr(p.publishablePublish, 'userErrors'); if (pe) throw new Error(pe);
        }
      }
    },

    async setVendor(gids, vendor) {
      for (const id of gids) {
        await gql(`mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { message } } }`, { product: { id, vendor } });
      }
    },

    // Set "available" for every variant of the given products (daily capacity).
    async setAvailable(gids, quantity) {
      if (!gids.length) return;
      const loc = await locationId();
      const items = [];
      for (const id of gids) {
        const d = await gql(`query($id: ID!) { product(id: $id) { variants(first: 100) { nodes { inventoryItem { id } } } } }`, { id });
        for (const v of d.product?.variants?.nodes || []) items.push(v.inventoryItem.id);
      }
      for (let i = 0; i < items.length; i += 100) {
        const chunk = items.slice(i, i + 100);
        const d = await gql(
          `mutation($input: InventorySetQuantitiesInput!, $key: String!) {
             inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { code message } }
           }`,
          { input: { name: 'available', reason: 'correction', referenceDocumentUri: 'gid://mercado-bloom/Capacity/' + Date.now(),
              quantities: chunk.map((inventoryItemId) => ({ inventoryItemId, locationId: loc, quantity: Math.max(0, quantity), changeFromQuantity: null })) },
            key: crypto.randomUUID() }
        );
        const e = userErr(d.inventorySetQuantities, 'userErrors'); if (e) throw new Error(e);
      }
    },

    async customerByEmail(email) {
      const d = await gql(`query($identifier: CustomerIdentifierInput!) { customer: customerByIdentifier(identifier: $identifier) { id email firstName tags } }`,
        { identifier: { emailAddress: email } });
      return d.customer || null;
    },
    async customer(id) {
      const gid = String(id).startsWith('gid://') ? id : `gid://shopify/Customer/${id}`;
      const d = await gql(`query($id: ID!) { customer(id: $id) { id email firstName lastName tags } }`, { id: gid });
      return d.customer || null;
    },
    // Find or create the customer, then swap tags. Returns the numeric customer id.
    async tagCustomer({ email, name, phone }, add = [], remove = []) {
      let c = await this.customerByEmail(email);
      if (!c) {
        const base = { email, firstName: name || '', tags: add };
        let d = await gql(`mutation($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`,
          { input: phone ? { ...base, phone } : base });
        if (userErr(d.customerCreate, 'userErrors') && phone) { // phone format rejected: retry without it
          d = await gql(`mutation($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`, { input: base });
        }
        const e = userErr(d.customerCreate, 'userErrors'); if (e) throw new Error('customerCreate: ' + e);
        c = d.customerCreate.customer;
      } else if (add.length) {
        await gql(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id: c.id, tags: add });
      }
      if (remove.length) {
        await gql(`mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`, { id: c.id, tags: remove });
      }
      return c.id.split('/').pop();
    },

    // Keeps the theme's "creators in your area" list (metaobject mb_creator) in sync.
    async upsertCreatorEntry(creator, approved) {
      const fields = [
        { key: 'name', value: creator.name || '' },
        { key: 'vendor', value: creator.vendor || '' },
        { key: 'city', value: creator.city || '' },
        { key: 'bio', value: creator.bio || '' },
        { key: 'approved', value: approved ? 'true' : 'false' },
      ];
      if (creator.logo_file_id) fields.push({ key: 'logo', value: creator.logo_file_id });
      const d = await gql(
        `mutation($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
           metaobjectUpsert(handle: $handle, metaobject: $metaobject) { metaobject { id } userErrors { field message } }
         }`,
        // Metaobject handles must be ASCII (a-z, 0-9, -, _). Hebrew business names fall back to creator-<id>.
        { handle: { type: 'mb_creator', handle: /^[a-z0-9][a-z0-9_-]*$/.test(creator.handle || '') ? creator.handle : `creator-${creator.id}` }, metaobject: { fields, capabilities: { publishable: { status: approved ? 'ACTIVE' : 'DRAFT' } } } }
      );
      const e = userErr(d.metaobjectUpsert, 'userErrors'); if (e) throw new Error('metaobjectUpsert: ' + e);
      return d.metaobjectUpsert.metaobject.id;
    },

    async fulfillOrder(orderId) {
      const d = await gql(
        `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } } }`,
        { id: `gid://shopify/Order/${orderId}` }
      );
      const open = (d.order?.fulfillmentOrders?.nodes || []).filter((f) => !['CLOSED', 'CANCELLED', 'INCOMPLETE'].includes(f.status));
      if (!open.length) return false;
      const r = await gql(
        `mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { message } } }`,
        { f: { lineItemsByFulfillmentOrder: open.map((f) => ({ fulfillmentOrderId: f.id })), notifyCustomer: true,
               trackingInfo: { company: 'Mercado Bloom' } } }
      );
      const e = userErr(r.fulfillmentCreate, 'userErrors'); if (e) throw new Error('fulfillmentCreate: ' + e);
      return true;
    },
  };
}

function money(v) { return (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); }

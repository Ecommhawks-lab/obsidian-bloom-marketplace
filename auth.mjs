// Sessions + password hashing for Cloudflare Workers.
// JWT via `jose` (Web Crypto), passwords via PBKDF2 (Web Crypto SubtleCrypto).
// No Node APIs, no bcrypt/jsonwebtoken.
import { SignJWT, jwtVerify } from 'jose';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const COOKIE = 'ob_session';
const PBKDF2_ITER = 100000;

function keyFromEnv(env) {
  return new TextEncoder().encode(env.JWT_SECRET || 'dev-insecure-secret-change-me');
}

/* ---------------- Passwords (PBKDF2-HMAC-SHA256) ---------------- */
function b64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function derive(pw, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, 256);
  return new Uint8Array(bits);
}
export async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pw, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(hash)}`;
}
export async function verifyPassword(pw, stored) {
  try {
    const [scheme, iterStr, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'pbkdf2') return false;
    const iter = Number(iterStr);
    const salt = unb64(saltB64);
    const expected = unb64(hashB64);
    const actual = await derive(pw, salt, iter);
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

/* ---------------- Sessions (JWT cookie) ---------------- */
export async function issueSession(c, payload) {
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(keyFromEnv(c.env));
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: true, // Workers is always served over HTTPS
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
}
export function clearSession(c) {
  deleteCookie(c, COOKIE, { path: '/' });
}
export async function readSession(c) {
  const t = getCookie(c, COOKIE);
  if (!t) return null;
  try {
    const { payload } = await jwtVerify(t, keyFromEnv(c.env));
    return payload;
  } catch {
    return null;
  }
}

/* ---------------- Route guards (Hono middleware) ---------------- */
export function requireVendor() {
  return async (c, next) => {
    const s = await readSession(c);
    if (!s || s.role !== 'vendor') return c.json({ ok: false, error: 'Not signed in.' }, 401);
    c.set('vendorId', s.vid);
    await next();
  };
}
export function requireAdmin() {
  return async (c, next) => {
    const s = await readSession(c);
    if (!s || s.role !== 'admin') return c.json({ ok: false, error: 'Admin only.' }, 401);
    await next();
  };
}

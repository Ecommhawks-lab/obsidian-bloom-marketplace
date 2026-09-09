// JWT cookie sessions + bcrypt passwords + route guards.
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const COOKIE = 'ob_session';
const isProd = process.env.NODE_ENV === 'production';

export function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
export function verifyPassword(pw, hash) { return bcrypt.compareSync(pw, hash); }

export function issue(res, payload) {
  const token = jwt.sign(payload, SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

export function clear(res) { res.clearCookie(COOKIE); }

export function readSession(req) {
  const t = req.cookies?.[COOKIE];
  if (!t) return null;
  try { return jwt.verify(t, SECRET); } catch { return null; }
}

export function requireVendor(req, res, next) {
  const s = readSession(req);
  if (!s || s.role !== 'vendor') return res.status(401).json({ ok: false, error: 'Not signed in.' });
  req.vendorId = s.vid;
  next();
}

export function requireAdmin(req, res, next) {
  const s = readSession(req);
  if (!s || s.role !== 'admin') return res.status(401).json({ ok: false, error: 'Admin only.' });
  next();
}

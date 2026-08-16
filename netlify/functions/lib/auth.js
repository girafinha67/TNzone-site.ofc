'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const rateLimit = require('./rate-limit');

const SESSION_SHORT_HOURS = 8;
const SESSION_REMEMBER_DAYS = 30;
const IS_PROD = process.env.NODE_ENV === 'production';

function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

async function findAdminByEmail(email) {
  return db.get('SELECT * FROM admins WHERE email = ?', [String(email).toLowerCase().trim()]);
}

async function createSession(adminId, remember, ip) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const id = crypto.randomUUID();
  const expiresAt = new Date(
    Date.now() + (remember ? SESSION_REMEMBER_DAYS * 24 : SESSION_SHORT_HOURS) * 3600 * 1000
  ).toISOString();

  await db.run(
    'INSERT INTO sessions (id, admin_id, token_hash, remember, expires_at, last_ip) VALUES (?, ?, ?, ?, ?, ?)',
    [id, adminId, tokenHash, remember ? 1 : 0, expiresAt, ip || null]
  );

  return { cookieValue: `${id}.${rawToken}`, expiresAt, remember };
}

async function validateSession(cookieValue) {
  if (!cookieValue || !cookieValue.includes('.')) return null;
  const [id, rawToken] = cookieValue.split('.');
  if (!id || !rawToken) return null;

  const session = await db.get('SELECT * FROM sessions WHERE id = ?', [id]);
  if (!session) return null;

  if (new Date(session.expires_at).getTime() < Date.now()) {
    await db.run('DELETE FROM sessions WHERE id = ?', [id]);
    return null;
  }

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const a = Buffer.from(tokenHash, 'hex');
  const b = Buffer.from(session.token_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const admin = await db.get('SELECT id, email FROM admins WHERE id = ?', [session.admin_id]);
  if (!admin) return null;

  return { admin, sessionId: id };
}

async function destroySession(cookieValue) {
  if (!cookieValue || !cookieValue.includes('.')) return;
  const [id] = cookieValue.split('.');
  await db.run('DELETE FROM sessions WHERE id = ?', [id]);
}

function sessionCookieHeader(cookieValue, expiresAt) {
  const parts = [
    `tnz_session=${cookieValue}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (IS_PROD) parts.push('Secure');
  return parts.join('; ');
}

function clearCookieHeader() {
  const parts = [
    'tnz_session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (IS_PROD) parts.push('Secure');
  return parts.join('; ');
}

// Rate limiting de login persistido no Postgres (tabela rate_hits) — funciona
// de forma consistente entre invocações "frias" da function, diferente de um
// contador em memória (que zera a cada cold start em ambiente serverless).
const LOGIN_BUCKET = 'login';
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

async function isRateLimited(ip) {
  return rateLimit.isRateLimited(LOGIN_BUCKET, ip, MAX_ATTEMPTS, WINDOW_MS);
}
async function registerAttempt(ip) {
  await rateLimit.registerHit(LOGIN_BUCKET, ip);
}
async function clearAttempts(ip) {
  await rateLimit.clearHits(LOGIN_BUCKET, ip);
}

async function log(adminId, action, details) {
  await db.run('INSERT INTO logs (admin_id, action, details) VALUES (?, ?, ?)', [
    adminId || null,
    action,
    details ? JSON.stringify(details) : null,
  ]);
}

module.exports = {
  verifyPassword,
  hashPassword,
  findAdminByEmail,
  createSession,
  validateSession,
  destroySession,
  sessionCookieHeader,
  clearCookieHeader,
  isRateLimited,
  registerAttempt,
  clearAttempts,
  log,
};

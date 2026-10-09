'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const rateLimit = require('./rate-limit');

const SESSION_SHORT_HOURS = 8; // sessão normal (sem "lembrar deste dispositivo")
const SESSION_REMEMBER_DAYS = 30; // "dispositivo confiável"

// Cookie "Secure" (só enviado por HTTPS): qualquer deploy real do Netlify
// (produção, preview ou branch deploy) já roda sob HTTPS, então o padrão
// correto é sempre marcar Secure — em vez de depender só de NODE_ENV=production
// estar configurado manualmente nas env vars do Netlify (fácil de esquecer,
// e nesse caso o cookie ficaria sem Secure em produção sem ninguém notar).
// `netlify dev` (emulação local) é a única situação onde a página roda em
// http:// puro, e o Netlify CLI seta NETLIFY_DEV=true nesse caso — é o sinal
// que usamos para desligar o Secure só ali. NODE_ENV=development continua
// funcionando como desligamento manual para qualquer outro setup local.
const IS_LOCAL_DEV = process.env.NETLIFY_DEV === 'true' || process.env.NODE_ENV === 'development';
const IS_PROD = !IS_LOCAL_DEV;
const COOKIE_NAME = 'rshoes_session';

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

// Cria uma sessão. Quando remember=true, ela vira o "dispositivo confiável":
// token de 30 dias guardado em cookie HttpOnly (nunca a senha). O token bruto
// só existe no cookie do navegador; no banco fica só o hash SHA-256 dele —
// por isso um dump do banco não permite forjar sessões.
async function createSession(adminId, remember, ip, userAgent) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const id = crypto.randomUUID();
  const expiresAt = new Date(
    Date.now() + (remember ? SESSION_REMEMBER_DAYS * 24 : SESSION_SHORT_HOURS) * 3600 * 1000
  ).toISOString();

  await db.run(
    `INSERT INTO sessions (id, admin_id, token_hash, remember, user_agent, expires_at, last_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, adminId, tokenHash, remember ? 1 : 0, (userAgent || '').slice(0, 300), expiresAt, ip || null]
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

  db.run('UPDATE sessions SET last_seen_at = NOW() WHERE id = ?', [id]).catch(() => {});

  return { admin, sessionId: id };
}

async function destroySession(cookieValue) {
  if (!cookieValue || !cookieValue.includes('.')) return;
  const [id] = cookieValue.split('.');
  await db.run('DELETE FROM sessions WHERE id = ?', [id]);
}

function sessionCookieHeader(cookieValue, expiresAt) {
  const parts = [
    `${COOKIE_NAME}=${cookieValue}`,
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
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (IS_PROD) parts.push('Secure');
  return parts.join('; ');
}

// Rate limiting de login persistido no Postgres — funciona de forma
// consistente entre cold starts, diferente de um contador em memória.
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
  COOKIE_NAME,
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

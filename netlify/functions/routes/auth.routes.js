'use strict';

const express = require('express');
const db = require('../lib/db');
const {
  findAdminByEmail,
  verifyPassword,
  hashPassword,
  createSession,
  destroySession,
  sessionCookieHeader,
  clearCookieHeader,
  isRateLimited,
  registerAttempt,
  clearAttempts,
  log,
} = require('../lib/auth');
const { clientIp, asyncHandler } = require('../lib/http-utils');

const router = express.Router();

router.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const ip = clientIp(req);
    if (await isRateLimited(ip)) {
      return res.status(429).json({ error: 'Muitas tentativas de login. Tente novamente em alguns minutos.' });
    }

    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const remember = !!req.body.remember;

    if (!email || !password) {
      return res.status(400).json({ error: 'Informe e-mail e senha.' });
    }

    const admin = await findAdminByEmail(email);
    if (!admin || !verifyPassword(password, admin.salt, admin.password_hash)) {
      await registerAttempt(ip);
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }

    await clearAttempts(ip);
    const { cookieValue, expiresAt } = await createSession(admin.id, remember, ip);
    res.setHeader('Set-Cookie', sessionCookieHeader(cookieValue, expiresAt));
    await log(admin.id, 'login', { ip });
    res.status(200).json({ ok: true, admin: { id: admin.id, email: admin.email } });
  })
);

router.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    await destroySession(req.cookies.tnz_session);
    res.setHeader('Set-Cookie', clearCookieHeader());
    if (req.admin) await log(req.admin.id, 'logout', {});
    res.status(200).json({ ok: true });
  })
);

router.get('/auth/me', (req, res) => {
  if (!req.admin) return res.status(401).json({ error: 'Não autenticado.' });
  res.status(200).json({ admin: req.admin });
});

router.post(
  '/auth/change-password',
  asyncHandler(async (req, res) => {
    if (!req.admin) return res.status(401).json({ error: 'Não autenticado.' });
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ error: 'Senha atual e nova senha (mínimo 8 caracteres) são obrigatórias.' });
    }
    const admin = await db.get('SELECT * FROM admins WHERE id = ?', [req.admin.id]);
    if (!verifyPassword(currentPassword, admin.salt, admin.password_hash)) {
      return res.status(401).json({ error: 'Senha atual incorreta.' });
    }
    const { salt, hash } = hashPassword(newPassword);
    await db.run('UPDATE admins SET password_hash = ?, salt = ? WHERE id = ?', [hash, salt, admin.id]);
    await log(admin.id, 'change_password', {});
    res.status(200).json({ ok: true });
  })
);

module.exports = router;

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
    const { cookieValue, expiresAt } = await createSession(admin.id, remember, ip, req.headers['user-agent']);
    res.setHeader('Set-Cookie', sessionCookieHeader(cookieValue, expiresAt));
    await log(admin.id, 'login', { ip, remember });
    res.status(200).json({ ok: true, admin: { id: admin.id, email: admin.email } });
  })
);

// "Sair deste dispositivo": apaga só a sessão/cookie atual.
router.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    await destroySession(req.cookies[require('../lib/auth').COOKIE_NAME]);
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

// Lista dispositivos/sessões confiáveis do admin logado (painel > Segurança).
router.get(
  '/admin/devices',
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT id, remember, user_agent, created_at, last_seen_at, expires_at, last_ip
       FROM sessions WHERE admin_id = ? ORDER BY last_seen_at DESC`,
      [req.admin.id]
    );
    const currentId = (req.cookies[require('../lib/auth').COOKIE_NAME] || '').split('.')[0];
    res.status(200).json({
      devices: rows.map((r) => ({ ...r, remember: !!r.remember, current: r.id === currentId })),
    });
  })
);

// Revoga um dispositivo/sessão específico (ou todos os outros).
router.delete(
  '/admin/devices/:id',
  asyncHandler(async (req, res) => {
    await db.run('DELETE FROM sessions WHERE id = ? AND admin_id = ?', [req.params.id, req.admin.id]);
    await log(req.admin.id, 'revoke_device', { id: req.params.id });
    res.status(200).json({ ok: true });
  })
);

module.exports = router;

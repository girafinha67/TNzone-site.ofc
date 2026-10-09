'use strict';

const express = require('express');
const db = require('../lib/db');
const { asyncHandler, parseIntId, clientIp } = require('../lib/http-utils');
const { log } = require('../lib/auth');
const rateLimit = require('../lib/rate-limit');
const { createFeedbackSignedUpload, feedbackPublicPrefix, deleteFeedbackMedia } = require('../lib/upload');

const router = express.Router();
const HOUR = 60 * 60 * 1000;
const UPLOAD_BUCKET = 'feedback_upload';
const SUBMIT_BUCKET = 'feedback_submit';
const UPLOAD_MAX = 10; // pedidos de upload por IP por hora
const SUBMIT_MAX = 5; // feedbacks enviados por IP por hora

function bad(res, msg) {
  return res.status(400).json({ error: msg });
}

// Mostra só "Nome S." no site; o nome completo fica visível apenas no painel.
function publicName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '';
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const d = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return false;
  const now = Date.now();
  return d.getTime() <= now + 24 * HOUR && d.getTime() >= now - 5 * 365 * 24 * HOUR;
}

// GET /api/feedbacks — público, só os aprovados.
router.get(
  '/feedbacks',
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT id, name, product_name, purchase_date, media_url, media_type
       FROM feedbacks WHERE status = 'approved' ORDER BY created_at DESC LIMIT 30`
    );
    res.status(200).json({
      feedbacks: rows.map((r) => ({
        id: r.id,
        name: publicName(r.name),
        product_name: r.product_name,
        purchase_date: r.purchase_date instanceof Date ? r.purchase_date.toISOString().slice(0, 10) : String(r.purchase_date).slice(0, 10),
        media_url: r.media_url,
        media_type: r.media_type,
      })),
    });
  })
);

// POST /api/feedbacks/upload-url — público. Devolve URL assinada para o navegador
// enviar a foto/vídeo direto ao Storage.
router.post(
  '/feedbacks/upload-url',
  asyncHandler(async (req, res) => {
    const ip = clientIp(req);
    if (await rateLimit.isRateLimited(UPLOAD_BUCKET, ip, UPLOAD_MAX, HOUR)) {
      return res.status(429).json({ error: 'Muitas tentativas. Tente de novo mais tarde.' });
    }
    const out = await createFeedbackSignedUpload(req.body && req.body.mime, req.body && req.body.size);
    await rateLimit.registerHit(UPLOAD_BUCKET, ip);
    res.status(200).json(out);
  })
);

// POST /api/feedbacks — público. Entra como 'pending' até um admin aprovar.
router.post(
  '/feedbacks',
  asyncHandler(async (req, res) => {
    const ip = clientIp(req);
    if (await rateLimit.isRateLimited(SUBMIT_BUCKET, ip, SUBMIT_MAX, HOUR)) {
      return res.status(429).json({ error: 'Você já enviou vários feedbacks. Tente de novo mais tarde.' });
    }
    const b = req.body || {};
    const name = String(b.name || '').trim().replace(/\s+/g, ' ');
    const product = String(b.product_name || '').trim().replace(/\s+/g, ' ');
    const date = String(b.purchase_date || '').trim();
    const mediaUrl = String(b.media_url || '').trim();
    const mediaType = b.media_type === 'video' ? 'video' : 'image';

    const words = name.split(' ').filter((w) => w.length >= 2);
    if (words.length < 2 || name.length > 120) return bad(res, 'Informe seu nome completo (nome e sobrenome).');
    if (product.length < 2 || product.length > 120) return bad(res, 'Informe o nome do produto que você comprou.');
    if (!validDate(date)) return bad(res, 'Informe uma data de compra válida.');
    if (!mediaUrl.startsWith(feedbackPublicPrefix())) return bad(res, 'Envie uma foto ou vídeo do seu pedido.');

    await db.run(
      "INSERT INTO feedbacks (name, product_name, purchase_date, media_url, media_type, status) VALUES (?, ?, ?, ?, ?, 'pending')",
      [name, product, date, mediaUrl, mediaType]
    );
    await rateLimit.registerHit(SUBMIT_BUCKET, ip);
    res.status(201).json({ ok: true });
  })
);

// ----- painel (protegido pelo requireAuth de /admin) -----
router.get(
  '/admin/feedbacks',
  asyncHandler(async (req, res) => {
    const status = req.query.status;
    const rows = ['pending', 'approved', 'rejected'].includes(status)
      ? await db.all('SELECT * FROM feedbacks WHERE status = ? ORDER BY created_at DESC', [status])
      : await db.all('SELECT * FROM feedbacks ORDER BY created_at DESC');
    const counts = await db.all('SELECT status, COUNT(*) AS n FROM feedbacks GROUP BY status');
    res.status(200).json({
      feedbacks: rows.map((r) => ({
        ...r,
        purchase_date: r.purchase_date instanceof Date ? r.purchase_date.toISOString().slice(0, 10) : String(r.purchase_date).slice(0, 10),
      })),
      counts: counts.reduce((acc, c) => ({ ...acc, [c.status]: Number(c.n) }), {}),
    });
  })
);

router.patch(
  '/admin/feedbacks/:id',
  asyncHandler(async (req, res) => {
    const id = parseIntId(req.params.id);
    if (!id) return bad(res, 'ID inválido.');
    const status = req.body && req.body.status;
    if (!['approved', 'rejected', 'pending'].includes(status)) return bad(res, 'Status inválido.');
    const existing = await db.get('SELECT id FROM feedbacks WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Feedback não encontrado.' });
    await db.run('UPDATE feedbacks SET status = ? WHERE id = ?', [status, id]);
    await log(req.admin.id, 'feedback_status', { id, status });
    res.status(200).json({ ok: true });
  })
);

router.delete(
  '/admin/feedbacks/:id',
  asyncHandler(async (req, res) => {
    const id = parseIntId(req.params.id);
    if (!id) return bad(res, 'ID inválido.');
    const existing = await db.get('SELECT * FROM feedbacks WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Feedback não encontrado.' });
    await db.run('DELETE FROM feedbacks WHERE id = ?', [id]);
    await deleteFeedbackMedia(existing.media_url);
    await log(req.admin.id, 'feedback_delete', { id });
    res.status(200).json({ ok: true });
  })
);

module.exports = router;

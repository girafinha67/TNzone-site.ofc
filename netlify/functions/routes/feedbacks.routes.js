'use strict';

const express = require('express');
const db = require('../lib/db');
const { asyncHandler, parseIntId, clientIp } = require('../lib/http-utils');
const { log } = require('../lib/auth');
const { broadcast } = require('../lib/realtime');
const rateLimit = require('../lib/rate-limit');

const router = express.Router();
const FEEDBACK_BUCKET = 'feedback';
const FEEDBACK_WINDOW_MS = 60 * 60 * 1000; // 1 hora
const FEEDBACK_MAX = 5;

router.get(
  '/feedbacks',
  asyncHandler(async (req, res) => {
    const rows = await db.all(
      `SELECT f.id, f.name, f.rating, f.comment, f.created_at, p.name AS product_name
       FROM feedbacks f LEFT JOIN products p ON p.id = f.product_id
       WHERE f.status = 'approved' ORDER BY f.created_at DESC LIMIT 50`
    );
    res.status(200).json({ feedbacks: rows });
  })
);

router.post(
  '/feedbacks',
  asyncHandler(async (req, res) => {
    const ip = clientIp(req);
    if (await rateLimit.isRateLimited(FEEDBACK_BUCKET, ip, FEEDBACK_MAX, FEEDBACK_WINDOW_MS)) {
      return res.status(429).json({ error: 'Muitas avaliações enviadas. Tente novamente mais tarde.' });
    }

    const b = req.body;
    const name = String(b.name || '').trim();
    const rating = Number(b.rating);
    const comment = String(b.comment || '').trim();

    if (!name || !rating || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      return res.status(400).json({ error: 'Nome e avaliação (1 a 5 estrelas) são obrigatórios.' });
    }

    let productId = null;
    if (b.product_id) {
      const pid = Number(b.product_id);
      if (Number.isInteger(pid) && pid > 0) {
        const product = await db.get('SELECT id FROM products WHERE id = ?', [pid]);
        if (product) productId = pid;
      }
    }

    const info = await db.run(
      "INSERT INTO feedbacks (name, rating, comment, product_id, status) VALUES (?, ?, ?, ?, 'pending')",
      [name.slice(0, 120), rating, comment.slice(0, 1000), productId]
    );
    await rateLimit.registerHit(FEEDBACK_BUCKET, ip);
    broadcast('changed', { entity: 'feedbacks' });
    res.status(201).json({ id: info.lastInsertRowid, status: 'pending' });
  })
);

router.get(
  '/admin/feedbacks',
  asyncHandler(async (req, res) => {
    const status = req.query.status;
    let rows;
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      rows = await db.all(
        `SELECT f.*, p.name AS product_name FROM feedbacks f LEFT JOIN products p ON p.id = f.product_id
         WHERE f.status = ? ORDER BY f.created_at DESC`,
        [status]
      );
    } else {
      rows = await db.all(
        `SELECT f.*, p.name AS product_name FROM feedbacks f LEFT JOIN products p ON p.id = f.product_id
         ORDER BY f.created_at DESC`
      );
    }
    res.status(200).json({ feedbacks: rows });
  })
);

router.patch(
  '/admin/feedbacks/:id',
  asyncHandler(async (req, res) => {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID de feedback inválido.' });
    const b = req.body;
    if (!['approved', 'rejected', 'pending'].includes(b.status)) {
      return res.status(400).json({ error: 'Status inválido.' });
    }
    const existing = await db.get('SELECT * FROM feedbacks WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Feedback não encontrado.' });
    await db.run('UPDATE feedbacks SET status = ? WHERE id = ?', [b.status, id]);
    await log(req.admin.id, 'feedback_status', { id, status: b.status });
    broadcast('changed', { entity: 'feedbacks' });
    res.status(200).json({ ok: true });
  })
);

router.delete(
  '/admin/feedbacks/:id',
  asyncHandler(async (req, res) => {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID de feedback inválido.' });
    const existing = await db.get('SELECT * FROM feedbacks WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Feedback não encontrado.' });
    await db.run('DELETE FROM feedbacks WHERE id = ?', [id]);
    await log(req.admin.id, 'feedback_delete', { id });
    broadcast('changed', { entity: 'feedbacks' });
    res.status(200).json({ ok: true });
  })
);

module.exports = router;

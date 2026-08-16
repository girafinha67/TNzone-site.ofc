'use strict';

const express = require('express');
const db = require('../lib/db');
const { asyncHandler } = require('../lib/http-utils');
const { log } = require('../lib/auth');
const { saveBase64Image } = require('../lib/upload');
const { broadcast } = require('../lib/realtime');

const router = express.Router();

// Whitelist de chaves configuráveis pelo painel — evita que o endpoint vire
// um "escreve qualquer coisa na tabela settings" caso o body seja manipulado.
const ALLOWED_SETTINGS_KEYS = new Set([
  'store_name', 'tagline', 'whatsapp_number', 'instagram', 'email_contact',
  'logo_url', 'favicon_url', 'primary_color', 'banner_title', 'banner_subtitle',
  'banner_image', 'footer_text', 'home_sections_order',
]);

const HOME_SECTION_KEYS = ['banner', 'categorias', 'destaques', 'novidades', 'feedbacks'];

router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const rows = await db.all('SELECT key, value FROM settings');
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    res.status(200).json({ settings: out });
  })
);

router.put(
  '/admin/settings',
  asyncHandler(async (req, res) => {
    const b = req.body;
    const entries = Object.entries(b).filter(([k]) => ALLOWED_SETTINGS_KEYS.has(k));

    if (Object.prototype.hasOwnProperty.call(b, 'home_sections_order')) {
      const order = b.home_sections_order;
      const isValid = Array.isArray(order)
        && order.length === HOME_SECTION_KEYS.length
        && HOME_SECTION_KEYS.every((k) => order.includes(k));
      if (!isValid) {
        return res.status(400).json({ error: 'Ordem das seções da home inválida.' });
      }
    }

    if (!entries.length) return res.status(400).json({ error: 'Nenhuma configuração válida enviada.' });

    await db.tx(async (t) => {
      for (const [k, v] of entries) {
        await t.run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
          [k, typeof v === 'string' ? v : JSON.stringify(v)]
        );
      }
    });
    await log(req.admin.id, 'settings_update', { keys: entries.map(([k]) => k) });
    broadcast('changed', { entity: 'settings' });
    res.status(200).json({ ok: true });
  })
);

// POST /api/admin/upload  { image: "data:image/png;base64,..." }
router.post(
  '/admin/upload',
  asyncHandler(async (req, res) => {
    const b = req.body;
    const { url, publicId } = await saveBase64Image(b.image);
    await log(req.admin.id, 'upload_image', { publicId });
    res.status(201).json({ filename: publicId, url });
  })
);

module.exports = router;

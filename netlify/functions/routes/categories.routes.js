'use strict';

const express = require('express');
const db = require('../lib/db');
const { slugify, asyncHandler, parseIntId } = require('../lib/http-utils');
const { log } = require('../lib/auth');

const router = express.Router();

async function uniqueSlug(name, ignoreId) {
  const base = slugify(name);
  let slug = base;
  let i = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await db.get('SELECT id FROM categories WHERE slug = ?', [slug]);
    if (!existing || existing.id === ignoreId) return slug;
    slug = `${base}-${i++}`;
  }
}

// GET /api/categories — pública mostra só ativas; admin vê todas.
router.get(
  '/categories',
  asyncHandler(async (req, res) => {
    const onlyActive = !req.admin;
    const rows = onlyActive
      ? await db.all('SELECT * FROM categories WHERE active = 1 ORDER BY order_index ASC')
      : await db.all('SELECT * FROM categories ORDER BY order_index ASC');
    res.status(200).json({ categories: rows.map((r) => ({ ...r, active: !!r.active })) });
  })
);

router.post(
  '/admin/categories',
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });
    const slug = await uniqueSlug(b.name);
    const maxRow = await db.get('SELECT MAX(order_index) AS m FROM categories');
    const maxOrder = maxRow.m || 0;
    const info = await db.run(
      'INSERT INTO categories (name, slug, image, description, order_index, active) VALUES (?, ?, ?, ?, ?, ?)',
      [String(b.name).trim(), slug, b.image || null, b.description || null, b.order_index ?? maxOrder + 1, b.active === false ? 0 : 1]
    );
    await log(req.admin.id, 'category_create', { id: info.lastInsertRowid, name: b.name });
    res.status(201).json({ id: info.lastInsertRowid, slug });
  })
);

router.put(
  '/admin/categories/:id',
  asyncHandler(async (req, res) => {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID de categoria inválido.' });
    const existing = await db.get('SELECT * FROM categories WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Categoria não encontrada.' });
    const b = req.body;
    if (b.name !== undefined && !String(b.name).trim()) {
      return res.status(400).json({ error: 'Nome é obrigatório.' });
    }
    const slug = b.name && b.name !== existing.name ? await uniqueSlug(b.name, id) : existing.slug;
    await db.run(
      'UPDATE categories SET name = ?, slug = ?, image = ?, description = ?, order_index = ?, active = ? WHERE id = ?',
      [
        b.name ?? existing.name,
        slug,
        b.image ?? existing.image,
        b.description !== undefined ? b.description : existing.description,
        b.order_index ?? existing.order_index,
        b.active != null ? (b.active ? 1 : 0) : existing.active,
        id,
      ]
    );
    await log(req.admin.id, 'category_update', { id });
    res.status(200).json({ ok: true, slug });
  })
);

router.delete(
  '/admin/categories/:id',
  asyncHandler(async (req, res) => {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID de categoria inválido.' });
    const existing = await db.get('SELECT * FROM categories WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Categoria não encontrada.' });
    await db.run('UPDATE products SET category_id = NULL WHERE category_id = ?', [id]);
    await db.run('DELETE FROM categories WHERE id = ?', [id]);
    await log(req.admin.id, 'category_delete', { id, name: existing.name });
    res.status(200).json({ ok: true });
  })
);

module.exports = router;

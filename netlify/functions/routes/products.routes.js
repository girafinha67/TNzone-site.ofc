'use strict';

const express = require('express');
const db = require('../lib/db');
const { slugify, asyncHandler, parseIntId } = require('../lib/http-utils');
const { log } = require('../lib/auth');
const { deleteImage } = require('../lib/upload');
const { broadcast } = require('../lib/realtime');

const router = express.Router();
const VALID_TYPES = ['tenis', 'camisa', 'calca', 'outro'];

// Valida os campos de um produto vindos do painel admin. Nunca confiamos só
// na validação do formulário no frontend — tudo é checado de novo aqui.
async function validateProductPayload(b, { partial } = {}) {
  const errors = [];

  if (!partial || b.name !== undefined) {
    if (!b.name || !String(b.name).trim()) errors.push('Nome é obrigatório.');
  }

  if (!partial || b.price !== undefined) {
    const price = Number(b.price);
    if (b.price == null || b.price === '' || !Number.isFinite(price) || price < 0) {
      errors.push('Preço deve ser um número maior ou igual a zero.');
    }
  }

  if (b.promo_price !== undefined && b.promo_price !== null && b.promo_price !== '') {
    const promo = Number(b.promo_price);
    const price = b.price != null ? Number(b.price) : null;
    if (!Number.isFinite(promo) || promo < 0) {
      errors.push('Preço promocional deve ser um número maior ou igual a zero.');
    } else if (price != null && Number.isFinite(price) && promo >= price) {
      errors.push('Preço promocional deve ser menor que o preço normal.');
    }
  }

  if (b.stock !== undefined && b.stock !== null && b.stock !== '') {
    const stock = Number(b.stock);
    if (!Number.isInteger(stock) || stock < 0) {
      errors.push('Estoque deve ser um número inteiro maior ou igual a zero.');
    }
  }

  if (b.type !== undefined && b.type !== null && b.type !== '' && !VALID_TYPES.includes(b.type)) {
    errors.push('Tipo de produto inválido.');
  }

  if (b.category_id !== undefined && b.category_id !== null && b.category_id !== '') {
    const catId = Number(b.category_id);
    if (!Number.isInteger(catId) || catId <= 0) {
      errors.push('Categoria inválida.');
    } else {
      const cat = await db.get('SELECT id FROM categories WHERE id = ?', [catId]);
      if (!cat) errors.push('Categoria selecionada não existe.');
    }
  }

  if (b.sizes !== undefined && b.sizes !== null && !Array.isArray(b.sizes)) errors.push('Tamanhos deve ser uma lista.');
  if (b.colors !== undefined && b.colors !== null && !Array.isArray(b.colors)) errors.push('Cores deve ser uma lista.');
  if (b.images !== undefined && b.images !== null && !Array.isArray(b.images)) errors.push('Imagens deve ser uma lista.');

  return errors;
}

function rowToProduct(row) {
  return {
    ...row,
    sizes: JSON.parse(row.sizes || '[]'),
    colors: JSON.parse(row.colors || '[]'),
    images: JSON.parse(row.images || '[]'),
    featured: !!row.featured,
    active: !!row.active,
  };
}

async function uniqueSlug(name, ignoreId) {
  const base = slugify(name);
  let slug = base;
  let i = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await db.get('SELECT id FROM products WHERE slug = ?', [slug]);
    if (!existing || existing.id === ignoreId) return slug;
    slug = `${base}-${i++}`;
  }
}

// GET /api/products (público)
router.get(
  '/products',
  asyncHandler(async (req, res) => {
    const query = req.query;
    const clauses = ['active = 1'];
    const params = [];

    if (query.category) {
      clauses.push('category_id = (SELECT id FROM categories WHERE slug = ?)');
      params.push(query.category);
    }
    if (query.type) {
      clauses.push('type = ?');
      params.push(query.type);
    }
    if (query.q) {
      clauses.push('(name LIKE ? OR description LIKE ?)');
      params.push(`%${query.q}%`, `%${query.q}%`);
    }
    if (query.minPrice && Number.isFinite(Number(query.minPrice))) {
      clauses.push('COALESCE(promo_price, price) >= ?');
      params.push(Number(query.minPrice));
    }
    if (query.maxPrice && Number.isFinite(Number(query.maxPrice))) {
      clauses.push('COALESCE(promo_price, price) <= ?');
      params.push(Number(query.maxPrice));
    }
    if (query.inStock === '1') clauses.push('stock > 0');
    if (query.featured === '1') clauses.push('featured = 1');

    let rows = await db.all(`SELECT * FROM products WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params);
    rows = rows.map(rowToProduct);

    if (query.size) rows = rows.filter((p) => p.sizes.includes(query.size));

    res.status(200).json({ products: rows });
  })
);

// GET /api/products/:slug (público)
router.get(
  '/products/:slug',
  asyncHandler(async (req, res) => {
    const row = await db.get('SELECT * FROM products WHERE slug = ? AND active = 1', [req.params.slug]);
    if (!row) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.status(200).json({ product: rowToProduct(row) });
  })
);

// GET /api/admin/products
router.get(
  '/admin/products',
  asyncHandler(async (req, res) => {
    const rows = await db.all('SELECT * FROM products ORDER BY created_at DESC');
    res.status(200).json({ products: rows.map(rowToProduct) });
  })
);

router.post(
  '/admin/products',
  asyncHandler(async (req, res) => {
    const b = req.body;
    const errors = await validateProductPayload(b);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });

    const slug = await uniqueSlug(b.name);
    const info = await db.run(
      `INSERT INTO products (name, slug, category_id, type, description, price, promo_price, sizes, colors, images, stock, featured, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        String(b.name).trim(),
        slug,
        b.category_id || null,
        VALID_TYPES.includes(b.type) ? b.type : 'outro',
        b.description || '',
        Number(b.price) || 0,
        b.promo_price != null && b.promo_price !== '' ? Number(b.promo_price) : null,
        JSON.stringify(b.sizes || []),
        JSON.stringify(b.colors || []),
        JSON.stringify(b.images || []),
        Number(b.stock) || 0,
        b.featured ? 1 : 0,
        b.active === false ? 0 : 1,
      ]
    );
    await log(req.admin.id, 'product_create', { id: info.lastInsertRowid, name: b.name });
    broadcast('changed', { entity: 'products' });
    res.status(201).json({ id: info.lastInsertRowid, slug });
  })
);

router.put(
  '/admin/products/:id',
  asyncHandler(async (req, res) => {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID de produto inválido.' });
    const existing = await db.get('SELECT * FROM products WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Produto não encontrado.' });

    const b = req.body;
    const errors = await validateProductPayload(b, { partial: true });
    if (errors.length) return res.status(400).json({ error: errors[0], errors });

    const slug = b.name && b.name !== existing.name ? await uniqueSlug(b.name, id) : existing.slug;

    await db.run(
      `UPDATE products SET
        name = ?, slug = ?, category_id = ?, type = ?, description = ?, price = ?, promo_price = ?,
        sizes = ?, colors = ?, images = ?, stock = ?, featured = ?, active = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        b.name != null ? String(b.name).trim() : existing.name,
        slug,
        b.category_id !== undefined ? (b.category_id || null) : existing.category_id,
        b.type !== undefined ? (VALID_TYPES.includes(b.type) ? b.type : existing.type) : existing.type,
        b.description ?? existing.description,
        b.price != null ? Number(b.price) : existing.price,
        b.promo_price !== undefined
          ? (b.promo_price === '' || b.promo_price === null ? null : Number(b.promo_price))
          : existing.promo_price,
        JSON.stringify(b.sizes ?? JSON.parse(existing.sizes)),
        JSON.stringify(b.colors ?? JSON.parse(existing.colors)),
        JSON.stringify(b.images ?? JSON.parse(existing.images)),
        b.stock != null ? Number(b.stock) : existing.stock,
        b.featured != null ? (b.featured ? 1 : 0) : existing.featured,
        b.active != null ? (b.active ? 1 : 0) : existing.active,
        id,
      ]
    );
    await log(req.admin.id, 'product_update', { id });
    broadcast('changed', { entity: 'products' });
    res.status(200).json({ ok: true, slug });
  })
);

router.delete(
  '/admin/products/:id',
  asyncHandler(async (req, res) => {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID de produto inválido.' });
    const existing = await db.get('SELECT * FROM products WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Produto não encontrado.' });

    for (const img of JSON.parse(existing.images || '[]')) await deleteImage(img);
    await db.run('DELETE FROM products WHERE id = ?', [id]);
    await log(req.admin.id, 'product_delete', { id, name: existing.name });
    broadcast('changed', { entity: 'products' });
    res.status(200).json({ ok: true });
  })
);

router.patch(
  '/admin/products/:id/toggle',
  asyncHandler(async (req, res) => {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID de produto inválido.' });
    const existing = await db.get('SELECT * FROM products WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Produto não encontrado.' });
    const next = existing.active ? 0 : 1;
    await db.run('UPDATE products SET active = ?, updated_at = NOW() WHERE id = ?', [next, id]);
    await log(req.admin.id, 'product_toggle_active', { id, active: !!next });
    broadcast('changed', { entity: 'products' });
    res.status(200).json({ ok: true, active: !!next });
  })
);

module.exports = router;

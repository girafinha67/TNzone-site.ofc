'use strict';

const express = require('express');
const db = require('../lib/db');
const { slugify, asyncHandler, parseIntId, escapeLike } = require('../lib/http-utils');
const { log } = require('../lib/auth');
const { deleteImage } = require('../lib/upload');
const { VALID_CATEGORY_SLUGS, CATEGORY_SLUG_TO_TAG } = require('../lib/category-tags');

const router = express.Router();

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
  if (b.tags !== undefined && b.tags !== null && !Array.isArray(b.tags)) errors.push('Tags deve ser uma lista.');

  if (b.category_tags !== undefined && b.category_tags !== null) {
    if (!Array.isArray(b.category_tags)) {
      errors.push('Categorias deve ser uma lista.');
    } else if (b.category_tags.some((s) => !VALID_CATEGORY_SLUGS.has(s))) {
      errors.push('Uma ou mais categorias selecionadas são inválidas.');
    }
  }

  return errors;
}

function rowToProduct(row) {
  return {
    ...row,
    sizes: JSON.parse(row.sizes || '[]'),
    colors: JSON.parse(row.colors || '[]'),
    images: JSON.parse(row.images || '[]'),
    tags: JSON.parse(row.tags || '[]'),
    category_tags: JSON.parse(row.category_tags || '[]'),
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

const SORT_MAP = {
  relevant: 'featured DESC, created_at DESC',
  recent: 'created_at DESC',
  price_asc: 'COALESCE(promo_price, price) ASC',
  price_desc: 'COALESCE(promo_price, price) DESC',
};

// GET /api/products — catálogo público: busca + filtros combinados + ordenação + paginação
router.get(
  '/products',
  asyncHandler(async (req, res) => {
    // Lista pública sempre fresca: produto recém-cadastrado não pode ficar preso em cache.
    res.set('Cache-Control', 'no-store');
    const q = req.query;
    const clauses = ['active = 1'];
    const params = [];

    if (q.category) {
      // O admin grava a categoria em products.category_tags (multi-seleção) e deixa
      // category_id vazio; o catálogo filtra por slug da tabela categories. Casamos
      // pelos dois caminhos, senão o produto novo nunca aparece em ?category=...
      const slug = String(q.category).trim();
      const tagSlugs = new Set([slug]);
      if (CATEGORY_SLUG_TO_TAG[slug]) tagSlugs.add(CATEGORY_SLUG_TO_TAG[slug]);
      const tagList = Array.from(tagSlugs);
      clauses.push(
        `(category_id = (SELECT id FROM categories WHERE slug = ?) OR ${tagList.map(() => 'category_tags ILIKE ?').join(' OR ')})`
      );
      params.push(slug, ...tagList.map((s) => `%"${escapeLike(s)}"%`));
    }
    if (q.categories) {
      const slugs = String(q.categories)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => VALID_CATEGORY_SLUGS.has(s));
      if (slugs.length) {
        clauses.push(`(${slugs.map(() => 'category_tags ILIKE ?').join(' OR ')})`);
        slugs.forEach((s) => params.push(`%"${s}"%`));
      }
    }
    if (q.brand) {
      clauses.push('LOWER(brand) = LOWER(?)');
      params.push(q.brand);
    }
    if (q.ids) {
      const idList = String(q.ids)
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (!idList.length) {
        return res.status(200).json({ products: [], total: 0, page: 1, pageSize: 0, totalPages: 1, brands: [] });
      }
      clauses.push(`id IN (${idList.map(() => '?').join(',')})`);
      params.push(...idList);
    }
    if (q.q) {
      clauses.push('(name ILIKE ? OR description ILIKE ? OR brand ILIKE ? OR tags ILIKE ?)');
      const like = `%${escapeLike(q.q)}%`;
      params.push(like, like, like, like);
    }
    if (q.minPrice && Number.isFinite(Number(q.minPrice))) {
      clauses.push('COALESCE(promo_price, price) >= ?');
      params.push(Number(q.minPrice));
    }
    if (q.maxPrice && Number.isFinite(Number(q.maxPrice))) {
      clauses.push('COALESCE(promo_price, price) <= ?');
      params.push(Number(q.maxPrice));
    }
    if (q.inStock === '1') clauses.push('stock > 0');
    if (q.promo === '1') clauses.push('promo_price IS NOT NULL');
    if (q.featured === '1') clauses.push('featured = 1');

    const sort = SORT_MAP[q.sort] || SORT_MAP.recent;
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const pageSizeCap = q.ids ? 100 : 48;
    const pageSize = Math.min(pageSizeCap, Math.max(1, parseInt(q.pageSize, 10) || (q.ids ? pageSizeCap : 12)));
    const offset = (page - 1) * pageSize;

    const where = clauses.join(' AND ');
    const totalRow = await db.get(`SELECT COUNT(*) AS n FROM products WHERE ${where}`, params);
    let rows = await db.all(
      `SELECT * FROM products WHERE ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    rows = rows.map(rowToProduct);

    // Tamanho/cor filtram sobre JSON — feito em memória após a query paginada
    // ser pequena o bastante (pageSize <= 48); para volumes maiores valeria
    // migrar sizes/colors para tabelas relacionais com índice GIN.
    if (q.size) rows = rows.filter((p) => p.sizes.includes(q.size));
    if (q.color) rows = rows.filter((p) => p.colors.map((c) => c.toLowerCase()).includes(String(q.color).toLowerCase()));

    const brandsRows = await db.all('SELECT DISTINCT brand FROM products WHERE active = 1 AND brand <> \'\' ORDER BY brand ASC');

    res.status(200).json({
      products: rows,
      total: Number(totalRow.n),
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(Number(totalRow.n) / pageSize)),
      brands: brandsRows.map((r) => r.brand),
    });
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

// ---------- Admin ----------

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
      `INSERT INTO products (name, slug, category_id, brand, sku, description, price, promo_price, sizes, colors, images, tags, category_tags, stock, featured, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        String(b.name).trim(),
        slug,
        b.category_id || null,
        b.brand ? String(b.brand).trim() : '',
        b.sku ? String(b.sku).trim() : null,
        b.description || '',
        Number(b.price) || 0,
        b.promo_price != null && b.promo_price !== '' ? Number(b.promo_price) : null,
        JSON.stringify(b.sizes || []),
        JSON.stringify(b.colors || []),
        JSON.stringify(b.images || []),
        JSON.stringify(b.tags || []),
        JSON.stringify(b.category_tags || []),
        Number(b.stock) || 0,
        b.featured ? 1 : 0,
        b.active === false ? 0 : 1,
      ]
    );
    await log(req.admin.id, 'product_create', { id: info.lastInsertRowid, name: b.name });
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
        name = ?, slug = ?, category_id = ?, brand = ?, sku = ?, description = ?, price = ?, promo_price = ?,
        sizes = ?, colors = ?, images = ?, tags = ?, category_tags = ?, stock = ?, featured = ?, active = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        b.name != null ? String(b.name).trim() : existing.name,
        slug,
        b.category_id !== undefined ? (b.category_id || null) : existing.category_id,
        b.brand !== undefined ? String(b.brand || '').trim() : existing.brand,
        b.sku !== undefined ? (b.sku ? String(b.sku).trim() : null) : existing.sku,
        b.description ?? existing.description,
        b.price != null ? Number(b.price) : existing.price,
        b.promo_price !== undefined
          ? (b.promo_price === '' || b.promo_price === null ? null : Number(b.promo_price))
          : existing.promo_price,
        JSON.stringify(b.sizes ?? JSON.parse(existing.sizes)),
        JSON.stringify(b.colors ?? JSON.parse(existing.colors)),
        JSON.stringify(b.images ?? JSON.parse(existing.images)),
        JSON.stringify(b.tags ?? JSON.parse(existing.tags)),
        JSON.stringify(b.category_tags ?? JSON.parse(existing.category_tags || '[]')),
        b.stock != null ? Number(b.stock) : existing.stock,
        b.featured != null ? (b.featured ? 1 : 0) : existing.featured,
        b.active != null ? (b.active ? 1 : 0) : existing.active,
        id,
      ]
    );
    await log(req.admin.id, 'product_update', { id });
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
    res.status(200).json({ ok: true });
  })
);

// Ativar/desativar sem excluir (ocultar temporariamente do catálogo).
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
    res.status(200).json({ ok: true, active: !!next });
  })
);

// Ajuste rápido de estoque.
router.patch(
  '/admin/products/:id/stock',
  asyncHandler(async (req, res) => {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID de produto inválido.' });
    const stock = Number(req.body.stock);
    if (!Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({ error: 'Estoque deve ser um número inteiro maior ou igual a zero.' });
    }
    const existing = await db.get('SELECT id FROM products WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Produto não encontrado.' });
    await db.run('UPDATE products SET stock = ?, updated_at = NOW() WHERE id = ?', [stock, id]);
    await log(req.admin.id, 'product_stock_update', { id, stock });
    res.status(200).json({ ok: true, stock });
  })
);

module.exports = router;

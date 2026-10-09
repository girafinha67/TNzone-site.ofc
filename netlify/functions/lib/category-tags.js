'use strict';

// Mesma lista de public/js/category-tags.js — mantenha os slugs em sincronia.
const CATEGORY_TAGS = [
  { slug: 'low', label: 'Nike' },
  { slug: 'high', label: 'Adidas' },
  { slug: 'slip-on', label: 'New Balance' },
  { slug: 'skate', label: 'Infantis' },
  { slug: 'edicao-limitada', label: 'Linha premium' },
  { slug: 'vans', label: 'Vans' },
];

const VALID_CATEGORY_SLUGS = new Set(CATEGORY_TAGS.map((c) => c.slug));

module.exports = { CATEGORY_TAGS, VALID_CATEGORY_SLUGS };

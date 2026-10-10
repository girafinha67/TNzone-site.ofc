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

// A tabela `categories` (usada pelos filtros do catálogo e pelos cards da home)
// tem slugs próprios (nike, adidas...), enquanto o formulário de produto do
// admin grava os slugs de CATEGORY_TAGS (low, high...). Este mapa liga os dois
// para que um produto cadastrado com a tag "Nike" apareça em ?category=nike.
const CATEGORY_SLUG_TO_TAG = {
  nike: 'low',
  adidas: 'high',
  'new-balance': 'slip-on',
  infantis: 'skate',
  'linha-premium': 'edicao-limitada',
  vans: 'vans',
};

module.exports = { CATEGORY_TAGS, VALID_CATEGORY_SLUGS, CATEGORY_SLUG_TO_TAG };

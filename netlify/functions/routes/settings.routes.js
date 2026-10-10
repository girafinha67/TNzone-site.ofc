'use strict';

const express = require('express');
const db = require('../lib/db');
const { asyncHandler } = require('../lib/http-utils');
const { log } = require('../lib/auth');

const router = express.Router();

const SETTINGS_KEY = 'home_content';

const DEFAULT_HOME_CONTENT = {
  topbar: [
    'FRETE GRÁTIS EM PEDIDOS ACIMA DE R$ 499',
    'PAGOU NO PIX, SEU PEDIDO SAI PRIMEIRO',
  ],
  hero: [
    { image: '/assets/hero/vans-old-skool.jpg', link: '/catalogo.html?brand=Vans' },
    { image: '/assets/hero/adidas-samba.jpg', link: '/catalogo.html?brand=Adidas' },
    { image: '/assets/hero/nike-dunk-low.jpg', link: '/catalogo.html?brand=Nike' },
  ],
  benefits: [
    { icon: '🚚', title: 'Frete grátis', text: 'Em pedidos acima de R$ 499.' },
    { icon: '↩️', title: 'Troca fácil', text: 'Até 7 dias depois que você receber.' },
    { icon: '🔒', title: 'Pagamento seguro', text: 'Pix seguro, confirmação automática.' },
    { icon: '🎧', title: 'Atendimento', text: 'Fale com a gente direto no WhatsApp.' },
  ],
  promoBanner: {
    active: true,
    eyebrow: 'POR TEMPO LIMITADO',
    title: 'Promoção rolando agora',
    subtitle: 'Até 40% de desconto em vários modelos.',
    ctaLabel: 'VER OFERTAS',
    ctaLink: '/catalogo.html?promo=1',
  },
};

function mergeDefaults(saved) {
  if (!saved || typeof saved !== 'object') return DEFAULT_HOME_CONTENT;
  return {
    topbar: Array.isArray(saved.topbar) && saved.topbar.length ? saved.topbar : DEFAULT_HOME_CONTENT.topbar,
    hero: Array.isArray(saved.hero) && saved.hero.length ? saved.hero : DEFAULT_HOME_CONTENT.hero,
    benefits: Array.isArray(saved.benefits) && saved.benefits.length ? saved.benefits : DEFAULT_HOME_CONTENT.benefits,
    promoBanner: saved.promoBanner && typeof saved.promoBanner === 'object'
      ? { ...DEFAULT_HOME_CONTENT.promoBanner, ...saved.promoBanner }
      : DEFAULT_HOME_CONTENT.promoBanner,
  };
}

// GET /api/settings/home — público, usado pela home para montar topbar/hero/benefícios/banner.
router.get(
  '/settings/home',
  asyncHandler(async (req, res) => {
    const raw = await db.getSetting(SETTINGS_KEY, null);
    let parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    }
    res.status(200).json(mergeDefaults(parsed));
  })
);

// PUT /api/admin/settings/home — protegido, usado pelo painel para editar os textos da home.
router.put(
  '/admin/settings/home',
  asyncHandler(async (req, res) => {
    const content = mergeDefaults(req.body || {});
    await db.setSetting(SETTINGS_KEY, JSON.stringify(content));
    await log(req.admin.id, 'settings_home_update', {});
    res.status(200).json({ ok: true, content });
  })
);

module.exports = router;

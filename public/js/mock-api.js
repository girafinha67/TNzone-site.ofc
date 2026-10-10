// TN'zone — camada de simulação da API, usada SOMENTE quando não há backend
// respondendo (por exemplo: preview estático no Spck Editor, que serve só
// arquivos e não roda as Netlify Functions). Em produção (Netlify), a API
// real sempre responde com Content-Type application/json, então este
// interceptador nunca entra em ação — ele só cobre o caso "não existe
// backend nenhum aqui" (404 de servidor estático / erro de rede).
(function () {
  'use strict';

  var realFetch = window.fetch.bind(window);

  // ---------------- dataset de exemplo (só para o preview) ----------------
  var CATS = [
    { id: 1, name: 'Nike', slug: 'low', image: '/assets/categories/nike.jpg', description: 'Cortes baixos para o dia a dia.', order_index: 1, active: true },
    { id: 2, name: 'Adidas', slug: 'high', image: '/assets/categories/adidas.jpg', description: 'Cano alto, presença de rua.', order_index: 2, active: true },
    { id: 3, name: 'New Balance', slug: 'slip-on', image: '/assets/categories/new-balance.jpg', description: 'Sem cadarço, praticidade total.', order_index: 3, active: true },
    { id: 4, name: 'Infantis', slug: 'skate', image: '/assets/categories/infantis.jpg', description: 'Resistência para o street.', order_index: 4, active: true },
    { id: 5, name: 'Linha premium', slug: 'edicao-limitada', image: '/assets/categories/linha-premium.jpg', description: 'Peças exclusivas e numeradas.', order_index: 5, active: true },
    { id: 6, name: 'Vans', slug: 'vans', image: '/assets/categories/vans.jpg', description: 'Clássicos street e skate.', order_index: 6, active: true },
  ];

  function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }

  // Produtos ilustrativos removidos — o catálogo real vem sempre da API/backend.
  var PRODUCTS = [];

  var HOME_DEFAULT = {
    topbar: ['PRÉVIA LOCAL NO SPCK (SEM BACKEND CONECTADO)', 'PUBLIQUE NO NETLIFY PARA VER OS DADOS REAIS'],
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
    promoBanner: { active: true, eyebrow: 'POR TEMPO LIMITADO', title: 'Promoção rolando agora', subtitle: 'Até 40% de desconto em vários modelos.', ctaLabel: 'VER OFERTAS', ctaLink: '/catalogo.html' },
  };

  function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function matchesQuery(p, params) {
    if (params.get('category')) {
      if (!p.category_tags.includes(params.get('category'))) return false;
    }
    if (params.get('categories')) {
      var slugs = params.get('categories').split(',');
      if (!slugs.some(function (s) { return p.category_tags.includes(s); })) return false;
    }
    if (params.get('brand') && p.brand.toLowerCase() !== params.get('brand').toLowerCase()) return false;
    if (params.get('q')) {
      var q = params.get('q').toLowerCase();
      var hay = (p.name + ' ' + p.description + ' ' + p.brand).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    if (params.get('minPrice') && (p.promo_price || p.price) < Number(params.get('minPrice'))) return false;
    if (params.get('maxPrice') && (p.promo_price || p.price) > Number(params.get('maxPrice'))) return false;
    if (params.get('promo') === '1' && !p.promo_price) return false;
    if (params.get('featured') === '1' && !p.featured) return false;
    if (params.get('ids')) {
      var ids = params.get('ids').split(',').map(Number);
      if (ids.indexOf(p.id) === -1) return false;
    }
    return true;
  }

  function sortProducts(list, sort) {
    var copy = list.slice();
    if (sort === 'price_asc') copy.sort(function (a, b) { return (a.promo_price || a.price) - (b.promo_price || b.price); });
    else if (sort === 'price_desc') copy.sort(function (a, b) { return (b.promo_price || b.price) - (a.promo_price || a.price); });
    else if (sort === 'recent') copy.sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    else copy.sort(function (a, b) { return (b.featured - a.featured) || (new Date(b.created_at) - new Date(a.created_at)); });
    return copy;
  }

  function handleProducts(params) {
    var filtered = PRODUCTS.filter(function (p) { return matchesQuery(p, params); });
    var sorted = sortProducts(filtered, params.get('sort'));
    var page = Math.max(1, parseInt(params.get('page'), 10) || 1);
    var pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize'), 10) || 12));
    var start = (page - 1) * pageSize;
    var pageItems = sorted.slice(start, start + pageSize);
    var brands = Array.from(new Set(PRODUCTS.map(function (p) { return p.brand; }))).sort();
    return jsonResponse({
      products: pageItems, total: filtered.length, page: page, pageSize: pageSize,
      totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)), brands: brands,
    });
  }

  function handleRoute(path, params) {
    if (path === '/api/products') return handleProducts(params);
    if (/^\/api\/products\/[^/]+$/.test(path)) {
      var slug = decodeURIComponent(path.split('/').pop());
      var product = PRODUCTS.find(function (p) { return p.slug === slug; });
      if (!product) return jsonResponse({ error: 'Produto não encontrado.' }, 404);
      return jsonResponse({ product: product });
    }
    if (path === '/api/categories') return jsonResponse({ categories: CATS });
    if (path === '/api/settings/home') return jsonResponse(HOME_DEFAULT);
    if (/^\/api\/payments\/(pix|picpay)\/create(-cart)?$/.test(path)) {
      return jsonResponse({ error: 'Pagamento indisponível neste preview (sem backend). Publique no Netlify com as variáveis de ambiente configuradas para testar o Pix de verdade.' }, 400);
    }
    return jsonResponse({ error: 'Rota de API não simulada neste preview: ' + path }, 404);
  }

  function looksLikeRealApi(response) {
    var ct = response.headers.get('content-type') || '';
    return ct.indexOf('application/json') !== -1;
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var pathname;
    try { pathname = new URL(url, location.href).pathname; } catch (e) { pathname = ''; }
    if (pathname.indexOf('/api/') !== 0) return realFetch(input, init);

    return realFetch(input, init).then(function (response) {
      if (looksLikeRealApi(response)) return response; // backend real respondeu (ok ou erro) — nunca mascara
      return mockFor(url); // resposta sem JSON (404 de arquivo estático etc.) → sem backend, usa mock
    }).catch(function () {
      return mockFor(url); // falha de rede (rota nem existe no servidor estático) → mock
    });
  };

  function mockFor(url) {
    try {
      var u = new URL(url, location.href);
      return handleRoute(u.pathname, u.searchParams);
    } catch (e) {
      return jsonResponse({ error: 'Preview sem backend.' }, 404);
    }
  }
})();

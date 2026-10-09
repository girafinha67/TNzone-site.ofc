// TN'zone — carrinho, favoritos, busca, mini-cart e header, compartilhados
// entre todas as páginas da loja. Carrinho/favoritos vivem no localStorage
// do navegador (o site não tem contas de cliente hoje — só login de admin).
window.RSShop = (function () {
  'use strict';

  var CART_KEY = 'rshoes_cart_v1';
  var FAV_KEY = 'rshoes_favorites_v1';
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------- helpers ----------------
  function money(v) {
    return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage indisponível — ignora */ }
  }
  function lineKey(item) { return item.productId + '|' + (item.size || '') + '|' + (item.color || ''); }

  // ---------------- cart ----------------
  function getCart() { return readJSON(CART_KEY, []); }
  function saveCart(cart) { writeJSON(CART_KEY, cart); renderBadges(); renderDrawer(); }
  function cartCount(cart) { return (cart || getCart()).reduce(function (n, it) { return n + it.quantity; }, 0); }

  function addToCart(item, opts) {
    opts = opts || {};
    var cart = getCart();
    var key = lineKey(item);
    var existing = cart.find(function (it) { return lineKey(it) === key; });
    if (existing) existing.quantity = Math.min(20, existing.quantity + (item.quantity || 1));
    else cart.push({ productId: item.productId, name: item.name, slug: item.slug, image: item.image,
      price: item.price, quantity: item.quantity || 1, size: item.size || null, color: item.color || null, stock: item.stock });
    saveCart(cart);
    if (!opts.silent) {
      toast((item.name || 'Produto') + ' adicionado ao carrinho');
      openDrawer();
    }
  }
  function updateCartQuantity(key, quantity) {
    var cart = getCart();
    var it = cart.find(function (i) { return lineKey(i) === key; });
    if (!it) return;
    it.quantity = Math.max(1, Math.min(20, quantity));
    saveCart(cart);
  }
  function removeFromCart(key) {
    saveCart(getCart().filter(function (i) { return lineKey(i) !== key; }));
  }
  function clearCart() { saveCart([]); }
  function cartSubtotal(cart) {
    return (cart || getCart()).reduce(function (sum, it) { return sum + Number(it.price || 0) * it.quantity; }, 0);
  }

  // ---------------- favorites ----------------
  function getFavorites() { return readJSON(FAV_KEY, []); }
  function isFavorite(id) { return getFavorites().indexOf(Number(id)) !== -1; }
  function toggleFavorite(id, meta) {
    id = Number(id);
    var favs = getFavorites();
    var idx = favs.indexOf(id);
    var nowFav;
    if (idx === -1) { favs.push(id); nowFav = true; } else { favs.splice(idx, 1); nowFav = false; }
    writeJSON(FAV_KEY, favs);
    renderBadges();
    syncFavIcons(id, nowFav);
    if (nowFav) toast((meta && meta.name ? meta.name : 'Produto') + ' adicionado aos favoritos');
    return nowFav;
  }
  function syncFavIcons(id, active) {
    document.querySelectorAll('.pc-fav[data-id="' + id + '"]').forEach(function (el) {
      el.classList.toggle('active', active);
      el.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  // ---------------- badges ----------------
  function renderBadges() {
    var cartBadge = document.getElementById('cartBadge');
    var favBadge = document.getElementById('favBadge');
    if (cartBadge) {
      var n = cartCount();
      cartBadge.textContent = n > 9 ? '9+' : String(n);
      cartBadge.classList.toggle('show', n > 0);
    }
    if (favBadge) {
      var f = getFavorites().length;
      favBadge.textContent = f > 9 ? '9+' : String(f);
      favBadge.classList.toggle('show', f > 0);
    }
  }

  // ---------------- toast ----------------
  function toast(msg) {
    var stack = document.getElementById('toastStack');
    if (!stack) return;
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    stack.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 350);
    }, 2600);
  }

  // ---------------- mini-cart drawer ----------------
  function drawerItemHtml(it) {
    var img = it.image
      ? '<img src="' + it.image + '" alt="">'
      : '<div style="width:76px;height:76px;background:var(--surface)"></div>';
    var meta = [it.size ? 'Tam. ' + it.size : null, it.color || null].filter(Boolean).join(' · ');
    var key = lineKey(it);
    return '<div class="drawer-item" data-key="' + key + '">' + img +
      '<div style="flex:1">' +
        '<div class="di-name">' + it.name + '</div>' +
        (meta ? '<div class="di-meta">' + meta + '</div>' : '') +
        '<div class="di-row">' +
          '<div class="qty-ctrl">' +
            '<button data-act="dec" aria-label="Diminuir">−</button>' +
            '<span>' + it.quantity + '</span>' +
            '<button data-act="inc" aria-label="Aumentar">+</button>' +
          '</div>' +
          '<div>' + money(Number(it.price) * it.quantity) + '</div>' +
        '</div>' +
        '<button class="di-remove" data-act="remove">Remover</button>' +
      '</div>' +
    '</div>';
  }
  function renderDrawer() {
    var body = document.getElementById('cartDrawerBody');
    var foot = document.getElementById('cartDrawerFoot');
    if (!body || !foot) return;
    var cart = getCart();
    if (!cart.length) {
      body.innerHTML = '<p class="drawer-empty">Seu carrinho está vazio.</p>';
      foot.innerHTML = '<a class="btn btn-outline" href="/catalogo.html">EXPLORAR A LOJA</a>';
      return;
    }
    body.innerHTML = cart.map(drawerItemHtml).join('');
    foot.innerHTML =
      '<div class="drawer-subtotal"><span>Subtotal</span><span>' + money(cartSubtotal(cart)) + '</span></div>' +
      '<a class="btn btn-dark" href="/carrinho.html">IR PARA O CARRINHO</a>' +
      '<a class="drawer-link" href="/catalogo.html">Continuar comprando</a>';
  }
  function openDrawer() {
    var scrim = document.getElementById('cartScrim'), drawer = document.getElementById('cartDrawer');
    if (!scrim || !drawer) return;
    renderDrawer();
    scrim.classList.add('open'); drawer.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeDrawer() {
    var scrim = document.getElementById('cartScrim'), drawer = document.getElementById('cartDrawer');
    if (!scrim || !drawer) return;
    scrim.classList.remove('open'); drawer.classList.remove('open');
    document.body.style.overflow = '';
  }
  function wireDrawer() {
    var body = document.getElementById('cartDrawerBody');
    var toggle = document.getElementById('cartToggle');
    var close = document.getElementById('cartClose');
    var scrim = document.getElementById('cartScrim');
    if (toggle) toggle.addEventListener('click', openDrawer);
    if (close) close.addEventListener('click', closeDrawer);
    if (scrim) scrim.addEventListener('click', closeDrawer);
    if (body) body.addEventListener('click', function (e) {
      var item = e.target.closest('.drawer-item');
      if (!item) return;
      var key = item.dataset.key;
      var act = e.target.dataset.act;
      if (act === 'remove') return removeFromCart(key);
      if (act === 'inc' || act === 'dec') {
        var cart = getCart();
        var it = cart.find(function (i) { return lineKey(i) === key; });
        if (!it) return;
        updateCartQuantity(key, it.quantity + (act === 'inc' ? 1 : -1));
        if (it.quantity <= 1 && act === 'dec') { /* mantém mínimo 1 — remover é ação explícita */ }
      }
    });
  }

  // ---------------- search overlay ----------------
  function wireSearch() {
    var toggle = document.getElementById('searchToggle');
    var overlay = document.getElementById('searchOverlay');
    var input = document.getElementById('searchInput');
    var close = document.getElementById('searchClose');
    var results = document.getElementById('searchResults');
    if (!overlay || !input || !results) return;
    var timer = null;

    function open() {
      overlay.classList.add('open');
      setTimeout(function () { input.focus(); }, 250);
    }
    function close2() { overlay.classList.remove('open'); }
    if (toggle) toggle.addEventListener('click', open);
    if (close) close.addEventListener('click', close2);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close2(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close2(); });

    function renderResults(list) {
      if (!list.length) { results.innerHTML = '<p class="search-hint">Nenhum produto encontrado.</p>'; return; }
      results.innerHTML = list.map(function (p) {
        var img = (p.images && p.images[0]) ? '<img src="' + p.images[0] + '" alt="">' : '<img alt="">';
        var price = p.promo_price ? money(p.promo_price) : money(p.price);
        return '<a class="search-item" href="/produto.html?slug=' + encodeURIComponent(p.slug) + '">' + img +
          '<div><div class="si-name">' + p.name + '</div><div class="si-brand">' + (p.brand || '') + '</div></div>' +
          '<div class="si-price">' + price + '</div></a>';
      }).join('');
    }

    input.addEventListener('input', function () {
      var q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) { results.innerHTML = '<p class="search-hint">Digite ao menos 2 letras.</p>'; return; }
      results.innerHTML = '<p class="search-hint">Buscando…</p>';
      timer = setTimeout(function () {
        fetch('/api/products?q=' + encodeURIComponent(q) + '&pageSize=8')
          .then(function (r) { return r.json(); })
          .then(function (data) { renderResults((data && data.products) || []); })
          .catch(function () { results.innerHTML = '<p class="search-hint">Não deu pra buscar agora.</p>'; });
      }, 320);
    });
  }

  // ---------------- header scroll + mobile menu ----------------
  function wireHeader() {
    var header = document.getElementById('siteHeader');
    if (header) {
      function onScroll() { header.classList.toggle('solid', window.scrollY > 30); }
      document.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
    var burger = document.getElementById('burger');
    var menu = document.getElementById('mobileMenu');
    var mmClose = document.getElementById('mmClose');
    if (burger && menu) {
      function toggleMenu() { burger.classList.toggle('open'); menu.classList.toggle('open'); }
      burger.addEventListener('click', toggleMenu);
      if (mmClose) mmClose.addEventListener('click', toggleMenu);
      menu.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', function () { burger.classList.remove('open'); menu.classList.remove('open'); });
      });
    }
  }

  // ---------------- scroll reveal (shared) ----------------
  function observeReveal(scope) {
    var list = (scope || document).querySelectorAll('.reveal:not(.in)');
    if ('IntersectionObserver' in window && !reduced) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
      }, { threshold: .12 });
      list.forEach(function (el) { io.observe(el); });
    } else {
      list.forEach(function (el) { el.classList.add('in'); });
    }
  }

  // ---------------- product card (shared markup) ----------------
  function productBadges(p) {
    var badges = [];
    if (p.promo_price) badges.push('<span class="pc-badge sale">OFERTA</span>');
    var created = p.created_at ? new Date(p.created_at) : null;
    if (created && (Date.now() - created.getTime()) < 1000 * 60 * 60 * 24 * 21) badges.push('<span class="pc-badge">NOVO</span>');
    if (p.featured) badges.push('<span class="pc-badge">DESTAQUE</span>');
    if (Number(p.stock) === 0) badges.push('<span class="pc-badge" style="background:var(--mute)">ESGOTADO</span>');
    return badges.join('');
  }
  function productCardHtml(p) {
    var images = p.images || [];
    var img1 = images[0]
      ? '<img class="img-1" src="' + images[0] + '" alt="' + p.name + '" loading="lazy">'
      : '<svg class="img-1" viewBox="0 0 200 100" style="color:#c9c9c1"><use href="#shoe"/></svg>';
    var img2 = images[1] ? '<img class="img-2" src="' + images[1] + '" alt="">' : '';
    var price = p.promo_price
      ? '<span class="pc-price has-promo">' + money(p.promo_price) + '</span><span class="pc-price-old">' + money(p.price) + '</span>'
      : '<span class="pc-price">' + money(p.price) + '</span>';
    var fav = isFavorite(p.id);
    return '<div class="product-card">' +
      '<div class="pc-visual">' +
        '<a href="/produto.html?slug=' + encodeURIComponent(p.slug) + '" aria-label="' + p.name + '">' + img1 + img2 + '</a>' +
        '<div class="pc-badges">' + productBadges(p) + '</div>' +
        '<button class="pc-fav' + (fav ? ' active' : '') + '" data-id="' + p.id + '" data-name="' + p.name.replace(/"/g, '&quot;') + '" aria-pressed="' + fav + '" aria-label="Favoritar">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s-7.5-4.6-10-9.3C.4 8.4 2 5 5.4 5c2 0 3.4 1 4.6 2.6C11.2 6 12.6 5 14.6 5 18 5 19.6 8.4 18 11.7 15.5 16.4 12 21 12 21z"/></svg>' +
        '</button>' +
        '<div class="pc-quick"><button data-quick-add="' + p.id + '">Adicionar ao carrinho</button></div>' +
      '</div>' +
      '<a class="pc-info" href="/produto.html?slug=' + encodeURIComponent(p.slug) + '">' +
        '<div class="pc-brand">' + (p.brand || '') + '</div>' +
        '<div class="pc-name">' + p.name + '</div>' +
        '<div class="pc-price-row">' + price + '</div>' +
      '</a>' +
    '</div>';
  }
  // Delegação de clique para favoritar/quick-add em qualquer grid de produtos
  // renderizado com productCardHtml — chame wireProductGrid(container, productsByIdMap).
  function wireProductGrid(container, productsById) {
    if (!container) return;
    container.addEventListener('click', function (e) {
      var favBtn = e.target.closest('.pc-fav');
      if (favBtn) {
        e.preventDefault();
        toggleFavorite(favBtn.dataset.id, { name: favBtn.dataset.name });
        return;
      }
      var quickBtn = e.target.closest('[data-quick-add]');
      if (quickBtn) {
        e.preventDefault();
        var id = Number(quickBtn.dataset.quickAdd);
        var p = productsById && productsById[id];
        if (!p) return;
        addToCart({
          productId: p.id, name: p.name, slug: p.slug,
          image: (p.images && p.images[0]) || null,
          price: p.promo_price || p.price, quantity: 1, stock: p.stock,
        });
      }
    });
  }

  function init() {
    wireHeader();
    wireSearch();
    wireDrawer();
    renderBadges();
    renderDrawer();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    money: money, toast: toast,
    getCart: getCart, addToCart: addToCart, updateCartQuantity: updateCartQuantity,
    removeFromCart: removeFromCart, clearCart: clearCart, cartSubtotal: cartSubtotal, cartCount: cartCount, lineKey: lineKey,
    getFavorites: getFavorites, isFavorite: isFavorite, toggleFavorite: toggleFavorite,
    renderBadges: renderBadges, openDrawer: openDrawer, closeDrawer: closeDrawer,
    observeReveal: observeReveal, productCardHtml: productCardHtml, wireProductGrid: wireProductGrid,
  };
})();

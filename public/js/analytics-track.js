// Tracking de Analytics do TN'zone — leve, anônimo, primeira-parte.
//
// O que faz:
//   - gera um ID de visitante (localStorage) e um ID de sessão (sessionStorage,
//     expira sozinho após 30min sem atividade ou ao fechar a aba);
//   - manda page_view/session_start automaticamente ao carregar a página;
//   - escuta cliques em qualquer link do WhatsApp (delegado, cobre botões
//     que já existem no HTML sem precisar editar cada um) e manda
//     whatsapp_click;
//   - expõe window.RshoesAnalytics.trackProductView/trackSearch/trackCategoryView
//     para as páginas de produto/catálogo chamarem com dados que só elas têm.
//
// O que NUNCA faz: não usa navigator.geolocation, não faz fingerprinting,
// não lê formulários, não manda senha/CPF/dado pessoal. Ver README.md.
window.RshoesAnalytics = (function () {
  'use strict';

  var SESSION_IDLE_MS = 30 * 60 * 1000; // 30min sem atividade = nova sessão
  var VISITOR_KEY = 'rshoes_visitor_id';
  var SESSION_KEY = 'rshoes_session_id';
  var SESSION_LAST_ACTIVITY_KEY = 'rshoes_session_last_activity';
  var SESSION_CTX_KEY = 'rshoes_session_ctx'; // referrer/UTM capturados 1x por sessão

  // ---------- storage seguro (modo anônimo/privado pode bloquear) ----------
  var memoryFallback = {};
  function safeGet(storage, key) {
    try { return storage.getItem(key); } catch (e) { return memoryFallback[key] || null; }
  }
  function safeSet(storage, key, value) {
    try { storage.setItem(key, value); } catch (e) { memoryFallback[key] = value; }
  }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    // Fallback simples para navegadores muito antigos (não precisa ser
    // criptograficamente forte — é só um identificador anônimo).
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getVisitorId() {
    var id = safeGet(window.localStorage, VISITOR_KEY);
    var isNew = false;
    if (!id) {
      id = uuid();
      isNew = true;
      safeSet(window.localStorage, VISITOR_KEY, id);
    }
    return { id: id, isNew: isNew };
  }

  function getUtmParams() {
    var params = new URLSearchParams(window.location.search);
    return {
      utm_source: params.get('utm_source') || '',
      utm_medium: params.get('utm_medium') || '',
      utm_campaign: params.get('utm_campaign') || '',
      utm_term: params.get('utm_term') || '',
      utm_content: params.get('utm_content') || '',
    };
  }

  // Sessão: se não existir ou estiver "velha" (>30min sem atividade
  // registrada), começa uma nova — e nesse momento captura referrer/UTM,
  // que ficam "grudados" na sessão até ela expirar (evita que a navegação
  // interna entre páginas do site apague a origem original do visitante).
  function getSession() {
    var now = Date.now();
    var id = safeGet(window.sessionStorage, SESSION_KEY);
    var lastActivity = Number(safeGet(window.sessionStorage, SESSION_LAST_ACTIVITY_KEY) || 0);
    var isNew = !id || (now - lastActivity) > SESSION_IDLE_MS;

    if (isNew) {
      id = uuid();
      safeSet(window.sessionStorage, SESSION_KEY, id);
      var ctx = { referrer: document.referrer || '', utm: getUtmParams(), entryPage: window.location.pathname };
      safeSet(window.sessionStorage, SESSION_CTX_KEY, JSON.stringify(ctx));
    }
    safeSet(window.sessionStorage, SESSION_LAST_ACTIVITY_KEY, String(now));

    var ctxRaw = safeGet(window.sessionStorage, SESSION_CTX_KEY);
    var ctx;
    try { ctx = JSON.parse(ctxRaw) || {}; } catch (e) { ctx = {}; }

    return { id: id, isNew: isNew, ctx: ctx };
  }

  var visitor = getVisitorId();
  var session = getSession();

  function send(eventName, extra) {
    var payload = {
      visitor_id: visitor.id,
      session_id: session.id,
      is_new_visitor: visitor.isNew,
      is_new_session: session.isNew,
      event_name: eventName,
      page_url: window.location.href,
      page_path: window.location.pathname,
      referrer: session.ctx.referrer || '',
      utm_source: (session.ctx.utm && session.ctx.utm.utm_source) || '',
      utm_medium: (session.ctx.utm && session.ctx.utm.utm_medium) || '',
      utm_campaign: (session.ctx.utm && session.ctx.utm.utm_campaign) || '',
      utm_term: (session.ctx.utm && session.ctx.utm.utm_term) || '',
      utm_content: (session.ctx.utm && session.ctx.utm.utm_content) || '',
      screen_w: window.screen ? window.screen.width : null,
      screen_h: window.screen ? window.screen.height : null,
    };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];

    // Depois do primeiro evento da sessão, is_new_visitor/is_new_session já
    // fizeram seu papel (servidor incrementa contadores só quando true) —
    // zera para não contar de novo em eventos seguintes da mesma "visita".
    visitor.isNew = false;
    session.isNew = false;

    try {
      var json = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        var blob = new Blob([json], { type: 'application/json' });
        navigator.sendBeacon('/api/track', blob);
      } else {
        fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true }).catch(function () {});
      }
    } catch (e) {
      // Tracking nunca pode quebrar a navegação do site.
    }
  }

  function trackProductView(product, categorySlugs) {
    if (!product) return;
    send('product_view', {
      product_id: product.id,
      product_slug: product.slug,
      category_slugs: Array.isArray(categorySlugs) ? categorySlugs : (product.category_tags || []),
    });
  }

  function trackSearch(term, resultsCount) {
    if (!term) return;
    send('search', { search_term: term, search_results: resultsCount });
  }

  function trackCategoryView(categorySlugs) {
    if (!categorySlugs || !categorySlugs.length) return;
    send('category_view', { category_slugs: categorySlugs });
  }

  function findProductId(el) {
    var host = el.closest('[data-product-id]');
    return host ? host.getAttribute('data-product-id') : null;
  }

  function initWhatsappClickTracking() {
    document.addEventListener('click', function (e) {
      var link = e.target.closest ? e.target.closest('a[href*="wa.me"]') : null;
      if (!link) return;
      var productId = findProductId(link);
      send('whatsapp_click', productId ? { product_id: productId } : {});
    }, { capture: true });
  }

  function init() {
    var wasNewSession = session.isNew;
    send(wasNewSession ? 'session_start' : 'page_view');
    if (wasNewSession) {
      // session_start já registra a página de entrada; ainda manda um
      // page_view próprio, porque "sessão iniciou" e "página vista" são
      // métricas diferentes (uma sessão com 1 pageview ainda é 1 pageview).
      send('page_view');
    }
    initWhatsappClickTracking();
  }

  init();

  return { trackProductView: trackProductView, trackSearch: trackSearch, trackCategoryView: trackCategoryView };
})();

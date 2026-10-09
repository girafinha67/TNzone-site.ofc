'use strict';

// Endpoint PÚBLICO de ingestão de eventos do Analytics — chamado pelo
// public/js/analytics-track.js via sendBeacon/fetch. NÃO fica atrás de
// autenticação (não faria sentido, é o visitante anônimo do site que
// dispara), mas é validado e limitado com cuidado por ser público:
//   - allowlist fechada de nomes de evento;
//   - todo campo de texto tem tamanho máximo;
//   - rate limit por visitor_id (reaproveita lib/rate-limit.js);
//   - nunca reflete erros detalhados na resposta (é uma "caixa preta" para
//     quem estiver de fora tentando sondar o sistema).
//
// Ver netlify/functions/lib/db.js para o desenho das tabelas e
// netlify/functions/lib/analytics-queries.js para como os dados viram os
// gráficos do painel.

const express = require('express');
const db = require('../lib/db');
const rateLimit = require('../lib/rate-limit');
const { clientIp, asyncHandler } = require('../lib/http-utils');
const { parseUserAgent } = require('../lib/ua-parse');
const { classifySource } = require('../lib/traffic-source');
const { lookupGeo } = require('../lib/geo');
const { VALID_CATEGORY_SLUGS } = require('../lib/category-tags');

const router = express.Router();

const ALLOWED_EVENTS = new Set([
  'session_start',
  'page_view',
  'product_view',
  'category_view',
  'search',
  'whatsapp_click',
  'product_click',
  // Preparados para o futuro (briefing item 17) — hoje nenhuma tela do site
  // ainda dispara estes, mas a tabela/validação já aceita sem precisar de
  // migração quando o carrinho/checkout/login existirem.
  'add_to_cart',
  'checkout_start',
  'purchase',
  'login',
]);

const TRACK_BUCKET = 'track';
const TRACK_WINDOW_MS = 5 * 60 * 1000;
const TRACK_MAX_EVENTS = 300; // generoso para uma sessão real; barra flood/abuso

function str(v, maxLen) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

function int(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function sanitizeCategorySlugs(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((s) => typeof s === 'string' && VALID_CATEGORY_SLUGS.has(s)).slice(0, 10);
}

router.post(
  '/track',
  asyncHandler(async (req, res) => {
    const analyticsEnabled = await db.getSetting('analytics_enabled', '1');
    if (analyticsEnabled === '0') return res.status(204).end();

    const b = req.body || {};

    const visitorId = str(b.visitor_id, 64);
    const sessionId = str(b.session_id, 64);
    const eventName = str(b.event_name, 40);

    if (!visitorId || !sessionId || !eventName || !ALLOWED_EVENTS.has(eventName)) {
      return res.status(400).json({ error: 'Payload de tracking inválido.' });
    }
    // IDs são gerados no cliente (crypto.randomUUID) — só validamos o
    // formato básico para não deixar qualquer string arbitrária virar PK.
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(visitorId) || !/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) {
      return res.status(400).json({ error: 'IDs de tracking inválidos.' });
    }

    if (await rateLimit.isRateLimited(TRACK_BUCKET, visitorId, TRACK_MAX_EVENTS, TRACK_WINDOW_MS)) {
      return res.status(429).end();
    }
    rateLimit.registerHit(TRACK_BUCKET, visitorId).catch(() => {});

    const isNewVisitor = b.is_new_visitor === true ? 1 : 0;
    const isNewSession = b.is_new_session === true;

    const pageUrl = str(b.page_url, 2000);
    const pagePath = str(b.page_path, 300);
    const referrer = str(b.referrer, 2000);

    const ua = req.headers['user-agent'] || '';
    const { deviceType, browser, os } = parseUserAgent(ua);

    const selfHost = (req.headers.host || '').replace(/^www\./, '');
    const { source, medium: classifiedMedium } = classifySource({
      referrer,
      utmSource: str(b.utm_source, 100),
      utmMedium: str(b.utm_medium, 100),
      selfHost,
    });
    const campaign = str(b.utm_campaign, 150);
    const term = str(b.utm_term, 150);
    const content = str(b.utm_content, 150);

    const screenW = int(b.screen_w);
    const screenH = int(b.screen_h);

    const productId = int(b.product_id);
    const productSlug = str(b.product_slug, 150);
    const categorySlugs = sanitizeCategorySlugs(b.category_slugs);
    const searchTerm = str(b.search_term, 150);
    const searchResults = int(b.search_results);

    // Geo só é consultado uma vez por sessão (no primeiro evento) para não
    // multiplicar chamadas externas — ver lib/geo.js (desligado por padrão).
    let geo = null;
    if (isNewSession) {
      geo = await lookupGeo(clientIp(req));
    }

    await db.tx(async (t) => {
      await t.run(
        `INSERT INTO analytics_visitors (id, first_seen_at, last_seen_at, sessions_count)
         VALUES (?, NOW(), NOW(), ?)
         ON CONFLICT (id) DO UPDATE SET
           last_seen_at = NOW(),
           sessions_count = analytics_visitors.sessions_count + EXCLUDED.sessions_count`,
        [visitorId, isNewSession ? 1 : 0]
      );

      await t.run(
        `INSERT INTO analytics_sessions (
           id, visitor_id, started_at, last_activity_at, is_new_visitor, entry_page, last_page,
           referrer, source, medium, campaign, term, content, device_type, browser, os,
           screen_w, screen_h, country, region, city, page_count, event_count
         ) VALUES (?, ?, NOW(), NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           last_activity_at = NOW(),
           last_page = EXCLUDED.last_page,
           page_count = analytics_sessions.page_count + EXCLUDED.page_count,
           event_count = analytics_sessions.event_count + EXCLUDED.event_count,
           entry_page = COALESCE(analytics_sessions.entry_page, EXCLUDED.entry_page),
           referrer = COALESCE(analytics_sessions.referrer, EXCLUDED.referrer),
           source = COALESCE(analytics_sessions.source, EXCLUDED.source),
           medium = COALESCE(analytics_sessions.medium, EXCLUDED.medium),
           campaign = COALESCE(analytics_sessions.campaign, EXCLUDED.campaign),
           term = COALESCE(analytics_sessions.term, EXCLUDED.term),
           content = COALESCE(analytics_sessions.content, EXCLUDED.content),
           device_type = COALESCE(analytics_sessions.device_type, EXCLUDED.device_type),
           browser = COALESCE(analytics_sessions.browser, EXCLUDED.browser),
           os = COALESCE(analytics_sessions.os, EXCLUDED.os),
           screen_w = COALESCE(analytics_sessions.screen_w, EXCLUDED.screen_w),
           screen_h = COALESCE(analytics_sessions.screen_h, EXCLUDED.screen_h),
           country = COALESCE(analytics_sessions.country, EXCLUDED.country),
           region = COALESCE(analytics_sessions.region, EXCLUDED.region),
           city = COALESCE(analytics_sessions.city, EXCLUDED.city)`,
        [
          sessionId,
          visitorId,
          isNewVisitor,
          pagePath,
          pagePath,
          referrer,
          source,
          classifiedMedium,
          campaign,
          term,
          content,
          deviceType,
          browser,
          os,
          screenW,
          screenH,
          geo ? geo.country : null,
          geo ? geo.region : null,
          geo ? geo.city : null,
          eventName === 'page_view' ? 1 : 0,
          1,
        ]
      );

      await t.run(
        `INSERT INTO analytics_events (
           event_name, session_id, visitor_id, page_url, page_path, referrer,
           product_id, product_slug, category_slugs, search_term, search_results, meta
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          eventName,
          sessionId,
          visitorId,
          pageUrl,
          pagePath,
          referrer,
          productId,
          productSlug,
          JSON.stringify(categorySlugs),
          searchTerm,
          searchResults,
          null,
        ]
      );
    });

    res.status(204).end();
  })
);

module.exports = router;

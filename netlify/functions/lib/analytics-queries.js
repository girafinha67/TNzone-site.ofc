'use strict';

// Camada de consultas do Analytics — cada função recebe o range já resolvido
// (ver lib/analytics-range.js) e devolve dados prontos para virar JSON (ou
// CSV, via lib/csv.js). Mantido separado das rotas para que o export em CSV
// use exatamente a mesma lógica que o dashboard usa (sem duplicar SQL).
//
// Regra geral de performance (briefing item 27): toda consulta aqui é
// agregada e filtrada por data com um índice cobrindo o filtro — nunca um
// SELECT * varrendo a tabela inteira.

const db = require('./db');
const { CATEGORY_TAGS } = require('./category-tags');

const CATEGORY_LABELS = new Map(CATEGORY_TAGS.map((c) => [c.slug, c.label]));

function pctChange(curr, prev) {
  curr = Number(curr) || 0;
  prev = Number(prev) || 0;
  if (prev === 0) return curr === 0 ? 0 : null; // null = "sem período anterior para comparar"
  return ((curr - prev) / prev) * 100;
}

// O driver 'pg' devolve colunas BIGINT (COUNT(*), etc.) como STRING em JS
// para não perder precisão — então "n"/"visitors" chegam aqui como "12", não
// 12. Sem essa conversão, tudo que soma esses campos com "+" no frontend
// (ex.: reduce() dos gráficos de donut) faz concatenação de texto em vez de
// soma ("0" + "12" + "3" = "0123"), quebrando totais e percentuais.
// Convertendo aqui, na única função por onde toda listagem passa, garante
// que o JSON de resposta (e o CSV de exportação) sempre devolvam números.
function toNumericRow(row, keys) {
  const out = { ...row };
  keys.forEach((k) => {
    if (k in out) out[k] = Number(out[k] || 0);
  });
  return out;
}

function withPercent(rows, key = 'n') {
  const numericRows = rows.map((r) => toNumericRow(r, [key, 'visitors']));
  const total = numericRows.reduce((sum, r) => sum + Number(r[key] || 0), 0);
  return numericRows.map((r) => ({ ...r, percent: total > 0 ? (Number(r[key] || 0) / total) * 100 : 0 }));
}

function iso(d) {
  return d instanceof Date ? d.toISOString() : d;
}

// ---------- Overview (cards do topo + comparação com período anterior) ----------
async function getOverview(range) {
  const { start, end, prevStart, prevEnd } = range;

  async function sessionStats(from, to) {
    return db.get(
      `SELECT
         COUNT(*) AS sessions,
         COUNT(DISTINCT visitor_id) AS visitors,
         COUNT(*) FILTER (WHERE is_new_visitor = 1) AS new_visitors,
         COALESCE(AVG(EXTRACT(EPOCH FROM (last_activity_at - started_at))), 0) AS avg_duration
       FROM analytics_sessions WHERE started_at >= ? AND started_at < ?`,
      [iso(from), iso(to)]
    );
  }

  async function eventStats(from, to) {
    return db.get(
      `SELECT
         COUNT(*) FILTER (WHERE event_name = 'page_view') AS pageviews,
         COUNT(*) FILTER (WHERE event_name = 'product_view') AS product_views,
         COUNT(*) FILTER (WHERE event_name = 'whatsapp_click') AS whatsapp_clicks
       FROM analytics_events WHERE created_at >= ? AND created_at < ?`,
      [iso(from), iso(to)]
    );
  }

  const [curSess, prevSess, curEvt, prevEvt] = await Promise.all([
    sessionStats(start, end),
    sessionStats(prevStart, prevEnd),
    eventStats(start, end),
    eventStats(prevStart, prevEnd),
  ]);

  const visitors = Number(curSess.visitors);
  const newVisitors = Number(curSess.new_visitors);
  const recurringVisitors = Math.max(0, visitors - newVisitors);
  const prevVisitors = Number(prevSess.visitors);
  const prevNewVisitors = Number(prevSess.new_visitors);
  const prevRecurringVisitors = Math.max(0, prevVisitors - prevNewVisitors);

  const returnRate = visitors > 0 ? (recurringVisitors / visitors) * 100 : 0;
  const prevReturnRate = prevVisitors > 0 ? (prevRecurringVisitors / prevVisitors) * 100 : 0;

  const metrics = {
    visitors,
    sessions: Number(curSess.sessions),
    newVisitors,
    recurringVisitors,
    returnRate,
    avgSessionDurationSec: Math.round(Number(curSess.avg_duration)),
    pageviews: Number(curEvt.pageviews),
    productViews: Number(curEvt.product_views),
    whatsappClicks: Number(curEvt.whatsapp_clicks),
  };

  const previous = {
    visitors: prevVisitors,
    sessions: Number(prevSess.sessions),
    newVisitors: prevNewVisitors,
    recurringVisitors: prevRecurringVisitors,
    returnRate: prevReturnRate,
    avgSessionDurationSec: Math.round(Number(prevSess.avg_duration)),
    pageviews: Number(prevEvt.pageviews),
    productViews: Number(prevEvt.product_views),
    whatsappClicks: Number(prevEvt.whatsapp_clicks),
  };

  const changePercent = {};
  Object.keys(metrics).forEach((k) => {
    changePercent[k] = pctChange(metrics[k], previous[k]);
  });

  return { metrics, previous, changePercent };
}

// ---------- Série temporal (gráfico de linhas) ----------
function buildBucketKeys(start, end, granularity) {
  const keys = [];
  const cursor = new Date(start);
  while (cursor < end) {
    keys.push(granularity === 'month' ? cursor.toISOString().slice(0, 7) : cursor.toISOString().slice(0, 10));
    if (granularity === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

function bucketKeyOf(dateVal, granularity) {
  const s = (dateVal instanceof Date ? dateVal.toISOString() : String(dateVal));
  return granularity === 'month' ? s.slice(0, 7) : s.slice(0, 10);
}

async function getTimeseries(range) {
  const { start, end, granularity } = range;

  const sessionRows = await db.all(
    `SELECT date_trunc(?, started_at AT TIME ZONE 'America/Sao_Paulo') AS bucket,
            COUNT(*) AS sessions,
            COUNT(DISTINCT visitor_id) AS visitors,
            COUNT(*) FILTER (WHERE is_new_visitor = 1) AS new_visitors
     FROM analytics_sessions
     WHERE started_at >= ? AND started_at < ?
     GROUP BY bucket ORDER BY bucket`,
    [granularity, iso(start), iso(end)]
  );

  const eventRows = await db.all(
    `SELECT date_trunc(?, created_at AT TIME ZONE 'America/Sao_Paulo') AS bucket,
            COUNT(*) FILTER (WHERE event_name = 'page_view') AS pageviews,
            COUNT(*) FILTER (WHERE event_name = 'whatsapp_click') AS whatsapp_clicks,
            COUNT(*) FILTER (WHERE event_name = 'product_view') AS product_views
     FROM analytics_events
     WHERE created_at >= ? AND created_at < ?
     GROUP BY bucket ORDER BY bucket`,
    [granularity, iso(start), iso(end)]
  );

  const sessMap = new Map(sessionRows.map((r) => [bucketKeyOf(r.bucket, granularity), r]));
  const evtMap = new Map(eventRows.map((r) => [bucketKeyOf(r.bucket, granularity), r]));

  const keys = buildBucketKeys(start, end, granularity);
  const points = keys.map((key) => {
    const s = sessMap.get(key);
    const e = evtMap.get(key);
    const visitors = s ? Number(s.visitors) : 0;
    const newVisitors = s ? Number(s.new_visitors) : 0;
    return {
      date: key,
      visitors,
      sessions: s ? Number(s.sessions) : 0,
      newVisitors,
      recurringVisitors: Math.max(0, visitors - newVisitors),
      pageviews: e ? Number(e.pageviews) : 0,
      whatsappClicks: e ? Number(e.whatsapp_clicks) : 0,
      productViews: e ? Number(e.product_views) : 0,
    };
  });

  return { granularity, points };
}

// ---------- Origem / campanhas ----------
async function getSources(range) {
  const { start, end } = range;
  const bySource = await db.all(
    `SELECT source, medium, COUNT(*) AS n, COUNT(DISTINCT visitor_id) AS visitors
     FROM analytics_sessions WHERE started_at >= ? AND started_at < ?
     GROUP BY source, medium ORDER BY n DESC LIMIT 20`,
    [iso(start), iso(end)]
  );
  const byCampaign = await db.all(
    `SELECT campaign, source, medium, content, term, COUNT(*) AS n
     FROM analytics_sessions
     WHERE started_at >= ? AND started_at < ? AND campaign IS NOT NULL AND campaign <> ''
     GROUP BY campaign, source, medium, content, term ORDER BY n DESC LIMIT 20`,
    [iso(start), iso(end)]
  );
  return { bySource: withPercent(bySource, 'n'), byCampaign: byCampaign.map((r) => toNumericRow(r, ['n'])) };
}

// ---------- Dispositivos / navegadores / SO ----------
async function getDevices(range) {
  const { start, end } = range;
  const params = [iso(start), iso(end)];

  const [deviceType, browser, os] = await Promise.all([
    db.all(
      `SELECT COALESCE(device_type, 'desconhecido') AS name, COUNT(*) AS n
       FROM analytics_sessions WHERE started_at >= ? AND started_at < ? GROUP BY name ORDER BY n DESC`,
      params
    ),
    db.all(
      `SELECT COALESCE(browser, 'Outro') AS name, COUNT(*) AS n
       FROM analytics_sessions WHERE started_at >= ? AND started_at < ? GROUP BY name ORDER BY n DESC LIMIT 10`,
      params
    ),
    db.all(
      `SELECT COALESCE(os, 'Outro') AS name, COUNT(*) AS n
       FROM analytics_sessions WHERE started_at >= ? AND started_at < ? GROUP BY name ORDER BY n DESC LIMIT 10`,
      params
    ),
  ]);

  return {
    deviceType: withPercent(deviceType, 'n'),
    browser: withPercent(browser, 'n'),
    os: withPercent(os, 'n'),
  };
}

// ---------- Localização (país / estado / cidade — aproximada, sem coordenadas) ----------
async function getLocations(range) {
  const { start, end } = range;
  const params = [iso(start), iso(end)];

  const countries = await db.all(
    `SELECT country, COUNT(*) AS n, COUNT(DISTINCT visitor_id) AS visitors
     FROM analytics_sessions WHERE started_at >= ? AND started_at < ? AND country IS NOT NULL
     GROUP BY country ORDER BY n DESC LIMIT 20`,
    params
  );
  const regions = await db.all(
    `SELECT country, region, COUNT(*) AS n, COUNT(DISTINCT visitor_id) AS visitors
     FROM analytics_sessions WHERE started_at >= ? AND started_at < ? AND region IS NOT NULL
     GROUP BY country, region ORDER BY n DESC LIMIT 20`,
    params
  );
  const cities = await db.all(
    `SELECT country, region, city, COUNT(*) AS n, COUNT(DISTINCT visitor_id) AS visitors
     FROM analytics_sessions WHERE started_at >= ? AND started_at < ? AND city IS NOT NULL
     GROUP BY country, region, city ORDER BY n DESC LIMIT 20`,
    params
  );

  const withoutGeo = await db.get(
    `SELECT COUNT(*) AS n FROM analytics_sessions WHERE started_at >= ? AND started_at < ? AND country IS NULL`,
    params
  );

  return {
    countries: withPercent(countries, 'n'),
    regions: withPercent(regions, 'n'),
    cities: withPercent(cities, 'n'),
    sessionsWithoutLocation: Number(withoutGeo.n),
  };
}

// ---------- Produtos mais vistos / mais clicados no WhatsApp ----------
async function getProducts(range, limit = 20) {
  const { start, end } = range;
  const rows = await db.all(
    `SELECT e.product_id,
            MAX(e.product_slug) AS slug,
            COUNT(*) FILTER (WHERE e.event_name = 'product_view') AS views,
            COUNT(*) FILTER (WHERE e.event_name = 'whatsapp_click') AS whatsapp_clicks,
            COUNT(DISTINCT e.visitor_id) AS visitors
     FROM analytics_events e
     WHERE e.product_id IS NOT NULL AND e.created_at >= ? AND e.created_at < ?
     GROUP BY e.product_id
     ORDER BY views DESC
     LIMIT ?`,
    [iso(start), iso(end), limit]
  );
  if (!rows.length) return { products: [] };

  const ids = rows.map((r) => r.product_id);
  const placeholders = ids.map(() => '?').join(',');
  const productRows = await db.all(
    `SELECT id, name, slug, active FROM products WHERE id IN (${placeholders})`,
    ids
  );
  const byId = new Map(productRows.map((p) => [p.id, p]));

  const products = rows.map((r) => {
    const p = byId.get(r.product_id);
    return {
      productId: r.product_id,
      name: p ? p.name : null,
      slug: p ? p.slug : r.slug,
      active: p ? !!p.active : null,
      removed: !p,
      views: Number(r.views),
      whatsappClicks: Number(r.whatsapp_clicks),
      visitors: Number(r.visitors),
    };
  });

  return { products };
}

// ---------- Categorias mais acessadas ----------
async function getCategories(range) {
  const { start, end } = range;
  const rows = await db.all(
    `SELECT slug, COUNT(*) AS n
     FROM analytics_events e, LATERAL jsonb_array_elements_text(NULLIF(e.category_slugs, '')::jsonb) AS slug
     WHERE e.event_name = 'product_view' AND e.created_at >= ? AND e.created_at < ?
     GROUP BY slug ORDER BY n DESC`,
    [iso(start), iso(end)]
  );
  const withLabel = rows.map((r) => ({ slug: r.slug, label: CATEGORY_LABELS.get(r.slug) || r.slug, n: Number(r.n) }));
  return { categories: withPercent(withLabel, 'n') };
}

// ---------- Páginas (mais vistas / entrada / saída) + termos buscados ----------
async function getPages(range) {
  const { start, end } = range;
  const evtParams = [iso(start), iso(end)];
  const sessParams = [iso(start), iso(end)];

  const topPages = await db.all(
    `SELECT page_path, COUNT(*) AS n, COUNT(DISTINCT visitor_id) AS visitors
     FROM analytics_events WHERE event_name = 'page_view' AND created_at >= ? AND created_at < ?
     GROUP BY page_path ORDER BY n DESC LIMIT 20`,
    evtParams
  );
  const entryPages = await db.all(
    `SELECT entry_page AS page_path, COUNT(*) AS n
     FROM analytics_sessions WHERE started_at >= ? AND started_at < ? AND entry_page IS NOT NULL
     GROUP BY entry_page ORDER BY n DESC LIMIT 20`,
    sessParams
  );
  const exitPages = await db.all(
    `SELECT last_page AS page_path, COUNT(*) AS n
     FROM analytics_sessions WHERE started_at >= ? AND started_at < ? AND last_page IS NOT NULL
     GROUP BY last_page ORDER BY n DESC LIMIT 20`,
    sessParams
  );
  const topSearches = await db.all(
    `SELECT search_term AS term, COUNT(*) AS n, COALESCE(AVG(search_results), 0) AS avg_results
     FROM analytics_events
     WHERE event_name = 'search' AND created_at >= ? AND created_at < ? AND search_term IS NOT NULL AND search_term <> ''
     GROUP BY search_term ORDER BY n DESC LIMIT 20`,
    evtParams
  );

  return {
    topPages: withPercent(topPages, 'n'),
    entryPages: withPercent(entryPages, 'n'),
    exitPages: withPercent(exitPages, 'n'),
    topSearches: topSearches.map((r) => ({ term: r.term, n: Number(r.n), avgResults: Math.round(Number(r.avg_results)) })),
  };
}

// ---------- Horário / dia da semana de maior movimento ----------
async function getHours(range) {
  const { start, end } = range;
  const params = [iso(start), iso(end)];

  const hourRows = await db.all(
    `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Sao_Paulo')::int AS hour, COUNT(*) AS n
     FROM analytics_events WHERE event_name = 'page_view' AND created_at >= ? AND created_at < ?
     GROUP BY hour ORDER BY hour`,
    params
  );
  const weekdayRows = await db.all(
    `SELECT EXTRACT(DOW FROM created_at AT TIME ZONE 'America/Sao_Paulo')::int AS dow, COUNT(*) AS n
     FROM analytics_events WHERE event_name = 'page_view' AND created_at >= ? AND created_at < ?
     GROUP BY dow ORDER BY dow`,
    params
  );

  const byHour = Array.from({ length: 24 }, (_, h) => {
    const row = hourRows.find((r) => Number(r.hour) === h);
    return { hour: h, n: row ? Number(row.n) : 0 };
  });
  // DOW do Postgres: 0=Domingo..6=Sábado. Reordenado para Seg..Dom, que é
  // como o painel exibe (mais natural para leitura em pt-BR).
  const dowLabels = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const byWeekday = order.map((dow) => {
    const row = weekdayRows.find((r) => Number(r.dow) === dow);
    return { label: dowLabels[dow], n: row ? Number(row.n) : 0 };
  });

  return { byHour, byWeekday };
}

// ---------- Tempo real ----------
async function getRealtime() {
  const activeNow = await db.get(
    `SELECT COUNT(*) AS n FROM analytics_sessions WHERE last_activity_at > NOW() - INTERVAL '5 minutes'`
  );
  const byPage = await db.all(
    `SELECT COALESCE(last_page, 'desconhecida') AS page, COUNT(*) AS n
     FROM analytics_sessions WHERE last_activity_at > NOW() - INTERVAL '5 minutes'
     GROUP BY page ORDER BY n DESC LIMIT 15`
  );
  return { activeNow: Number(activeNow.n), byPage: byPage.map((r) => ({ page: r.page, n: Number(r.n) })) };
}

module.exports = {
  getOverview,
  getTimeseries,
  getSources,
  getDevices,
  getLocations,
  getProducts,
  getCategories,
  getPages,
  getHours,
  getRealtime,
};

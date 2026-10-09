'use strict';

// Rotas administrativas do "📊 Análise de usuários". Todas ficam sob
// /admin/analytics/* e por isso já passam pelo requireAuth global montado
// em netlify/functions/api.js (apiRouter.use('/admin', requireAuth)) — não
// precisa repetir a checagem de sessão aqui, mas nunca confie só nisso: o
// middleware é a barreira real, o frontend só esconde o link do menu.

const express = require('express');
const db = require('../lib/db');
const { asyncHandler } = require('../lib/http-utils');
const { log } = require('../lib/auth');
const { parseRange } = require('../lib/analytics-range');
const { toCsv } = require('../lib/csv');
const queries = require('../lib/analytics-queries');

const router = express.Router();

function rangeFromReq(req) {
  return parseRange(req.query);
}

router.get(
  '/admin/analytics/overview',
  asyncHandler(async (req, res) => {
    const data = await queries.getOverview(rangeFromReq(req));
    res.status(200).json(data);
  })
);

router.get(
  '/admin/analytics/timeseries',
  asyncHandler(async (req, res) => {
    const data = await queries.getTimeseries(rangeFromReq(req));
    res.status(200).json(data);
  })
);

router.get(
  '/admin/analytics/sources',
  asyncHandler(async (req, res) => {
    const data = await queries.getSources(rangeFromReq(req));
    res.status(200).json(data);
  })
);

router.get(
  '/admin/analytics/devices',
  asyncHandler(async (req, res) => {
    const data = await queries.getDevices(rangeFromReq(req));
    res.status(200).json(data);
  })
);

router.get(
  '/admin/analytics/locations',
  asyncHandler(async (req, res) => {
    const data = await queries.getLocations(rangeFromReq(req));
    res.status(200).json(data);
  })
);

router.get(
  '/admin/analytics/products',
  asyncHandler(async (req, res) => {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const data = await queries.getProducts(rangeFromReq(req), limit);
    res.status(200).json(data);
  })
);

router.get(
  '/admin/analytics/categories',
  asyncHandler(async (req, res) => {
    const data = await queries.getCategories(rangeFromReq(req));
    res.status(200).json(data);
  })
);

router.get(
  '/admin/analytics/pages',
  asyncHandler(async (req, res) => {
    const data = await queries.getPages(rangeFromReq(req));
    res.status(200).json(data);
  })
);

router.get(
  '/admin/analytics/hours',
  asyncHandler(async (req, res) => {
    const data = await queries.getHours(rangeFromReq(req));
    res.status(200).json(data);
  })
);

// Sem filtro de período — é sempre "neste exato momento" (janela fixa de
// 5min dentro da própria consulta, ver lib/analytics-queries.js).
router.get(
  '/admin/analytics/realtime',
  asyncHandler(async (req, res) => {
    const data = await queries.getRealtime();
    res.status(200).json(data);
  })
);

// Liga/desliga a coleta (briefing item 25 — LGPD/consentimento). Quando
// desligado, POST /api/track passa a responder 204 sem gravar nada.
router.get(
  '/admin/analytics/settings',
  asyncHandler(async (req, res) => {
    const enabled = (await db.getSetting('analytics_enabled', '1')) !== '0';
    res.status(200).json({ enabled });
  })
);

router.put(
  '/admin/analytics/settings',
  asyncHandler(async (req, res) => {
    const enabled = req.body && req.body.enabled !== false;
    await db.setSetting('analytics_enabled', enabled ? '1' : '0');
    await log(req.admin.id, 'analytics_toggle', { enabled });
    res.status(200).json({ enabled });
  })
);

const EXPORTERS = {
  overview: async (range) => {
    const d = await queries.getOverview(range);
    const rows = Object.keys(d.metrics).map((k) => ({ metric: k, value: d.metrics[k], previous: d.previous[k] }));
    return { rows, columns: [{ key: 'metric', label: 'Métrica' }, { key: 'value', label: 'Valor' }, { key: 'previous', label: 'Período anterior' }] };
  },
  sources: async (range) => {
    const d = await queries.getSources(range);
    return {
      rows: d.bySource,
      columns: [
        { key: 'source', label: 'Origem' }, { key: 'medium', label: 'Meio' },
        { key: 'n', label: 'Sessões' }, { key: 'visitors', label: 'Visitantes' }, { key: 'percent', label: '%' },
      ],
    };
  },
  devices: async (range) => {
    const d = await queries.getDevices(range);
    const rows = [
      ...d.deviceType.map((r) => ({ tipo: 'Dispositivo', valor: r.name, n: r.n, percent: r.percent })),
      ...d.browser.map((r) => ({ tipo: 'Navegador', valor: r.name, n: r.n, percent: r.percent })),
      ...d.os.map((r) => ({ tipo: 'Sistema operacional', valor: r.name, n: r.n, percent: r.percent })),
    ];
    return { rows, columns: [{ key: 'tipo', label: 'Tipo' }, { key: 'valor', label: 'Valor' }, { key: 'n', label: 'Sessões' }, { key: 'percent', label: '%' }] };
  },
  locations: async (range) => {
    const d = await queries.getLocations(range);
    return {
      rows: d.cities,
      columns: [
        { key: 'country', label: 'País' }, { key: 'region', label: 'Estado' }, { key: 'city', label: 'Cidade' },
        { key: 'n', label: 'Sessões' }, { key: 'visitors', label: 'Visitantes' }, { key: 'percent', label: '%' },
      ],
    };
  },
  products: async (range) => {
    const d = await queries.getProducts(range, 50);
    return {
      rows: d.products,
      columns: [
        { key: 'name', label: 'Produto' }, { key: 'slug', label: 'Slug' }, { key: 'views', label: 'Visualizações' },
        { key: 'whatsappClicks', label: 'Cliques WhatsApp' }, { key: 'visitors', label: 'Visitantes' },
      ],
    };
  },
  categories: async (range) => {
    const d = await queries.getCategories(range);
    return { rows: d.categories, columns: [{ key: 'label', label: 'Categoria' }, { key: 'n', label: 'Visualizações' }, { key: 'percent', label: '%' }] };
  },
  pages: async (range) => {
    const d = await queries.getPages(range);
    return { rows: d.topPages, columns: [{ key: 'page_path', label: 'Página' }, { key: 'n', label: 'Visualizações' }, { key: 'visitors', label: 'Visitantes' }, { key: 'percent', label: '%' }] };
  },
};

router.get(
  '/admin/analytics/export',
  asyncHandler(async (req, res) => {
    const dataset = String(req.query.dataset || 'overview');
    if (!Object.prototype.hasOwnProperty.call(EXPORTERS, dataset)) {
      return res.status(400).json({ error: 'Conjunto de dados inválido para exportação.' });
    }
    const exporter = EXPORTERS[dataset];

    const range = rangeFromReq(req);
    const { rows, columns } = await exporter(range);
    const csv = toCsv(rows, columns);

    await log(req.admin.id, 'analytics_export', { dataset, range: range.range });

    res.status(200)
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="analytics-${dataset}-${range.startStr}-a-${range.endStrExclusive}.csv"`)
      .send(`\uFEFF${csv}`); // BOM — Excel no Windows abre acentuação certo
  })
);

module.exports = router;

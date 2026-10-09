(function () {
  'use strict';

  var state = { range: '30d', from: null, to: null };
  var lastTimeseries = null;
  var realtimeTimer = null;
  var overviewTimer = null;

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtNum(n) { return Number(n || 0).toLocaleString('pt-BR'); }
  function fmtPct(n) { return Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%'; }

  function fmtDuration(totalSeconds) {
    var s = Math.max(0, Math.round(Number(totalSeconds) || 0));
    var m = Math.floor(s / 60);
    var rem = s % 60;
    if (m <= 0) return rem + 's';
    return m + 'min ' + rem + 's';
  }

  function emptyNoteHtml(msg) {
    return '<p class="az-empty-note">' + esc(msg || 'Ainda não há dados suficientes para este período.') + '</p>';
  }

  function rankListHtml(rows, nameFn, valueFn, opts) {
    opts = opts || {};
    var list = rows.slice(0, opts.limit || 10);
    var max = Math.max.apply(null, list.map(valueFn).concat([1]));
    return list.map(function (r) {
      var v = valueFn(r);
      var pct = max > 0 ? (v / max) * 100 : 0;
      var extra = opts.showPercent && r.percent != null ? ' · ' + fmtPct(r.percent) : '';
      return (
        '<div class="az-bar-row">' +
        '<div class="az-bar-label"><span class="name">' + esc(nameFn(r)) + '</span><span class="val">' + fmtNum(v) + extra + '</span></div>' +
        '<div class="az-bar-track"><div class="az-bar-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
        '</div>'
      );
    }).join('');
  }

  var COMPARISON_LABELS = {
    today: 'vs. ontem', yesterday: 'vs. o dia anterior', '7d': 'vs. os 7 dias anteriores',
    '30d': 'vs. os 30 dias anteriores', this_week: 'vs. semana passada', last_week: 'vs. a semana anterior',
    this_month: 'vs. mês passado', last_month: 'vs. o mês anterior', this_year: 'vs. ano passado',
    last_year: 'vs. o ano anterior', '12m': 'vs. os 12 meses anteriores', custom: 'vs. período anterior equivalente',
  };

  function renderDelta(change) {
    var note = COMPARISON_LABELS[state.range] || 'vs. período anterior';
    if (change === null || change === undefined) {
      return '<span class="az-delta flat">novo neste período</span>';
    }
    var rounded = Math.round(change * 10) / 10;
    if (rounded === 0) return '<span class="az-delta flat">▬ estável</span><span class="az-delta-note">' + note + '</span>';
    var cls = rounded > 0 ? 'up' : 'down';
    var arrow = rounded > 0 ? '▲' : '▼';
    return '<span class="az-delta ' + cls + '">' + arrow + ' ' + fmtPct(Math.abs(rounded)) + '</span><span class="az-delta-note">' + note + '</span>';
  }

  // Agrupa em "top N-1 + Outros" para o donut não virar uma pizza de 15
  // fatias ilegível; a lista detalhada (rankListHtml) ao lado continua
  // mostrando todo mundo, então nada de informação é perdido, só resumido
  // no gráfico.
  function donutRows(rows, nameFn, valueFn, maxSlices) {
    var sorted = rows.slice().sort(function (a, b) { return valueFn(b) - valueFn(a); });
    var head = sorted.slice(0, maxSlices - 1);
    var rest = sorted.slice(maxSlices - 1);
    var restTotal = rest.reduce(function (s, r) { return s + valueFn(r); }, 0);
    var out = head.map(function (r) { return { label: nameFn(r), value: valueFn(r) }; });
    if (restTotal > 0) out.push({ label: 'Outros', value: restTotal });
    return out;
  }

  function renderDonutWithLegend(donutId, legendId, rows, nameFn, valueFn) {
    var total = rows.reduce(function (s, r) { return s + valueFn(r); }, 0);
    if (!total) {
      $(donutId).innerHTML = '';
      $(legendId).innerHTML = emptyNoteHtml();
      return;
    }
    var data = donutRows(rows, nameFn, valueFn, 6).map(function (d, i) {
      return { label: d.label, value: d.value, color: window.RshoesCharts.palette[i % window.RshoesCharts.palette.length] };
    });
    $(donutId).innerHTML = window.RshoesCharts.donutChart(data, { size: 130 });
    $(legendId).innerHTML = data.map(function (d) {
      return '<span><span class="az-dot" style="background:' + d.color + '"></span>' + esc(d.label) + ': ' + fmtPct((d.value / total) * 100) + '</span>';
    }).join('');
  }

  function flagFor(country) {
    if (!country) return '🌍';
    var n = country.toLowerCase();
    return (n === 'brasil' || n === 'brazil') ? '🇧🇷' : '🌍';
  }

  function shortDateLabel(dateStr, granularity) {
    if (granularity === 'month') {
      var parts = dateStr.split('-');
      var months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
      return months[Number(parts[1]) - 1] + '/' + parts[0].slice(2);
    }
    var d = dateStr.split('-');
    return d[2] + '/' + d[1];
  }

  var METRIC_LABELS = { visitors: 'Visitantes', sessions: 'Sessões', pageviews: 'Visualizações', whatsappClicks: 'Cliques WhatsApp' };

  function rangeQuery() {
    if (state.range === 'custom' && state.from && state.to) {
      return 'range=custom&from=' + encodeURIComponent(state.from) + '&to=' + encodeURIComponent(state.to);
    }
    return 'range=' + encodeURIComponent(state.range);
  }

  // ---------- Cards ----------
  var CARD_DEFS = [
    { key: 'visitors', label: '👥 Visitantes', fmt: fmtNum },
    { key: 'recurringVisitors', label: '🔄 Recorrentes', fmt: fmtNum },
    { key: 'newVisitors', label: '🆕 Novos', fmt: fmtNum },
    { key: 'pageviews', label: '👁️ Visualizações', fmt: fmtNum },
    { key: 'productViews', label: '🛍️ Produtos vistos', fmt: fmtNum },
    { key: 'whatsappClicks', label: '💬 Cliques WhatsApp', fmt: fmtNum },
    { key: 'sessions', label: '⏱️ Sessões', fmt: fmtNum },
    { key: 'returnRate', label: '📈 Taxa de retorno', fmt: fmtPct },
    { key: 'avgSessionDurationSec', label: '⏳ Duração média', fmt: fmtDuration },
  ];

  async function loadOverview() {
    var data = await window.RshoesApi.get('/admin/analytics/overview?' + rangeQuery());
    var m = data.metrics, ch = data.changePercent;
    $('statGrid').innerHTML = CARD_DEFS.map(function (d) {
      return (
        '<div class="az-stat-card">' +
        '<div class="az-label">' + d.label + '</div>' +
        '<div class="az-n">' + d.fmt(m[d.key]) + '</div>' +
        renderDelta(ch[d.key]) +
        '</div>'
      );
    }).join('');
  }

  // ---------- Série temporal ----------
  async function loadTimeseries() {
    lastTimeseries = await window.RshoesApi.get('/admin/analytics/timeseries?' + rangeQuery());
    renderTimeseriesChart();
  }

  function renderTimeseriesChart() {
    if (!lastTimeseries) return;
    var metric = $('tsMetric').value;
    var points = lastTimeseries.points;
    var labels = points.map(function (p) { return shortDateLabel(p.date, lastTimeseries.granularity); });

    if (metric === 'new_vs_recurring') {
      var hasAny = points.some(function (p) { return p.newVisitors > 0 || p.recurringVisitors > 0; });
      if (!hasAny) { $('tsChart').innerHTML = ''; $('tsLegend').innerHTML = emptyNoteHtml(); return; }
      var series = [
        { name: '🆕 Novos', color: '#ff5a1f', data: points.map(function (p) { return p.newVisitors; }) },
        { name: '🔄 Recorrentes', color: '#f7f1e8', data: points.map(function (p) { return p.recurringVisitors; }) },
      ];
      $('tsChart').innerHTML = window.RshoesCharts.lineChart(labels, series);
      $('tsLegend').innerHTML = series.map(function (s) {
        return '<span><span class="az-dot" style="background:' + s.color + '"></span>' + esc(s.name) + '</span>';
      }).join('');
      return;
    }

    var hasData = points.some(function (p) { return p[metric] > 0; });
    if (!hasData) {
      $('tsChart').innerHTML = '';
      $('tsLegend').innerHTML = emptyNoteHtml();
      return;
    }
    var values = points.map(function (p) { return p[metric]; });
    $('tsChart').innerHTML = window.RshoesCharts.lineChart(labels, [{ name: METRIC_LABELS[metric], color: 'var(--gold)', data: values }]);
    $('tsLegend').innerHTML = '<span><span class="az-dot" style="background:var(--gold)"></span>' + esc(METRIC_LABELS[metric]) + '</span>';
  }

  // ---------- Origem ----------
  async function loadSources() {
    var data = await window.RshoesApi.get('/admin/analytics/sources?' + rangeQuery());
    var rows = data.bySource.filter(function (r) { return r.n > 0; });
    renderDonutWithLegend('sourceDonut', 'sourceLegend', rows, function (r) { return r.source; }, function (r) { return r.n; });
    $('sourcesList').innerHTML = rows.length
      ? rankListHtml(rows, function (r) { return r.source + (r.medium ? ' (' + r.medium + ')' : ''); }, function (r) { return r.n; }, { showPercent: true, limit: 8 })
      : emptyNoteHtml();
  }

  // ---------- Dispositivos / navegador / SO ----------
  var DEVICE_LABELS = { mobile: '📱 Mobile', desktop: '💻 Desktop', tablet: '📲 Tablet', desconhecido: 'Desconhecido' };

  async function loadDevices() {
    var data = await window.RshoesApi.get('/admin/analytics/devices?' + rangeQuery());

    var deviceRows = data.deviceType.filter(function (r) { return r.n > 0; });
    renderDonutWithLegend('deviceDonut', 'deviceLegend', deviceRows, function (r) { return DEVICE_LABELS[r.name] || r.name; }, function (r) { return r.n; });

    var browserRows = data.browser.filter(function (r) { return r.n > 0; });
    renderDonutWithLegend('browserDonut', 'browserLegend', browserRows, function (r) { return r.name; }, function (r) { return r.n; });
    $('browserList').innerHTML = browserRows.length
      ? rankListHtml(browserRows, function (r) { return r.name; }, function (r) { return r.n; }, { showPercent: true })
      : emptyNoteHtml();

    var osRows = data.os.filter(function (r) { return r.n > 0; });
    renderDonutWithLegend('osDonut', 'osLegend', osRows, function (r) { return r.name; }, function (r) { return r.n; });
    $('osList').innerHTML = osRows.length
      ? rankListHtml(osRows, function (r) { return r.name; }, function (r) { return r.n; }, { showPercent: true })
      : emptyNoteHtml();
  }

  // ---------- Localização ----------
  async function loadLocations() {
    var data = await window.RshoesApi.get('/admin/analytics/locations?' + rangeQuery());
    if (!data.countries.length) {
      $('locationsList').innerHTML = data.sessionsWithoutLocation > 0
        ? emptyNoteHtml('Localização aproximada não está habilitada (ver IPGEO_PROVIDER no README).')
        : emptyNoteHtml();
      return;
    }
    var header = data.countries.map(function (c) { return flagFor(c.country) + ' ' + esc(c.country) + ': ' + fmtNum(c.n); }).join(' · ');
    var html = '<p style="margin:0 0 14px; font-weight:700;">' + header + '</p>';
    if (data.regions.length) {
      html += rankListHtml(data.regions, function (r) { return r.region; }, function (r) { return r.n; }, { limit: 8 });
    }
    if (data.cities.length) {
      html += '<h5 style="margin:16px 0 10px; font-size:0.76rem; color:var(--grey); text-transform:uppercase; letter-spacing:.06em;">Principais cidades</h5>';
      html += rankListHtml(data.cities, function (r) { return r.city + (r.region ? ', ' + r.region : ''); }, function (r) { return r.n; }, { limit: 6 });
    }
    $('locationsList').innerHTML = html;
  }

  // ---------- Produtos ----------
  async function loadProducts() {
    var data = await window.RshoesApi.get('/admin/analytics/products?limit=10&' + rangeQuery());
    if (!data.products.length) { $('productsCard').innerHTML = emptyNoteHtml(); return; }
    var max = Math.max.apply(null, data.products.map(function (p) { return p.views; }).concat([1]));
    $('productsCard').innerHTML = data.products.map(function (p, i) {
      var pct = max > 0 ? (p.views / max) * 100 : 0;
      var label = p.removed ? (esc(p.name || p.slug || ('Produto #' + p.productId)) + ' (removido)') : esc(p.name || p.slug);
      var nameHtml = (!p.removed && p.slug)
        ? '<a href="/produto.html?slug=' + encodeURIComponent(p.slug) + '" target="_blank" style="color:inherit;">' + label + '</a>'
        : label;
      return (
        '<div class="az-bar-row">' +
        '<div class="az-bar-label"><span class="name">' + (i + 1) + '. ' + nameHtml + '</span>' +
        '<span class="val">' + fmtNum(p.views) + ' views · 💬 ' + fmtNum(p.whatsappClicks) + '</span></div>' +
        '<div class="az-bar-track"><div class="az-bar-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
        '</div>'
      );
    }).join('');
  }

  // ---------- Categorias ----------
  async function loadCategories() {
    var data = await window.RshoesApi.get('/admin/analytics/categories?' + rangeQuery());
    $('categoriesList').innerHTML = data.categories.length
      ? rankListHtml(data.categories, function (r) { return r.label; }, function (r) { return r.n; }, { showPercent: true })
      : emptyNoteHtml();
  }

  // ---------- Páginas ----------
  async function loadPages() {
    var data = await window.RshoesApi.get('/admin/analytics/pages?' + rangeQuery());
    $('topPagesList').innerHTML = data.topPages.length
      ? rankListHtml(data.topPages, function (r) { return r.page_path; }, function (r) { return r.n; }, { showPercent: true, limit: 8 })
      : emptyNoteHtml();
    $('entryPagesList').innerHTML = data.entryPages.length
      ? rankListHtml(data.entryPages, function (r) { return r.page_path; }, function (r) { return r.n; }, { showPercent: true, limit: 8 })
      : emptyNoteHtml();
    $('exitPagesList').innerHTML = data.exitPages.length
      ? rankListHtml(data.exitPages, function (r) { return r.page_path; }, function (r) { return r.n; }, { showPercent: true, limit: 8 })
      : emptyNoteHtml();

    if (data.topSearches.length) {
      $('searchSection').style.display = '';
      $('searchList').innerHTML = rankListHtml(data.topSearches, function (r) { return '"' + r.term + '"'; }, function (r) { return r.n; }, { limit: 12 });
    } else {
      $('searchSection').style.display = 'none';
    }
  }

  // ---------- Horários ----------
  async function loadHours() {
    var data = await window.RshoesApi.get('/admin/analytics/hours?' + rangeQuery());
    var hasHours = data.byHour.some(function (h) { return h.n > 0; });
    $('hoursChart').innerHTML = hasHours
      ? window.RshoesCharts.barChart(data.byHour.map(function (h) { return String(h.hour).padStart(2, '0') + 'h'; }), data.byHour.map(function (h) { return h.n; }))
      : emptyNoteHtml();
    var hasWeek = data.byWeekday.some(function (w) { return w.n > 0; });
    $('weekdayChart').innerHTML = hasWeek
      ? window.RshoesCharts.barChart(data.byWeekday.map(function (w) { return w.label; }), data.byWeekday.map(function (w) { return w.n; }), { color: 'var(--gold-bright)' })
      : emptyNoteHtml();
  }

  // ---------- Tempo real ----------
  async function loadRealtime() {
    try {
      var data = await window.RshoesApi.get('/admin/analytics/realtime');
      $('liveCount').textContent = fmtNum(data.activeNow);
      $('realtimePages').innerHTML = data.byPage.length
        ? rankListHtml(data.byPage, function (r) { return r.page; }, function (r) { return r.n; }, { limit: 15 })
        : '<p class="az-empty-note">Nenhum visitante ativo nos últimos 5 minutos.</p>';
    } catch (err) {
      // silencioso — não interrompe o resto do painel por causa do polling
    }
  }

  // ---------- Toggle de coleta ----------
  function setSwitchState(enabled) {
    var el = $('analyticsSwitch');
    el.classList.toggle('on', enabled);
    el.dataset.enabled = enabled ? '1' : '0';
    $('analyticsSwitchLabel').textContent = enabled ? 'Ativada' : 'Desativada';
  }

  async function loadSettings() {
    var data = await window.RshoesApi.get('/admin/analytics/settings');
    setSwitchState(data.enabled);
  }

  function bindSettingsToggle() {
    $('analyticsSwitch').addEventListener('click', async function () {
      var next = $('analyticsSwitch').dataset.enabled !== '1';
      try {
        await window.RshoesApi.put('/admin/analytics/settings', { enabled: next });
        setSwitchState(next);
        window.RshoesAdmin.toast(next ? 'Coleta de Analytics ativada.' : 'Coleta de Analytics desativada. Novos eventos não serão mais salvos.');
      } catch (err) {
        window.RshoesAdmin.toast(err.message, true);
      }
    });
  }

  // ---------- Exportação CSV ----------
  function updateExportLinks() {
    var q = rangeQuery();
    [
      ['exportOverview', 'overview'], ['exportSources', 'sources'], ['exportProducts', 'products'],
      ['exportCategories', 'categories'], ['exportLocations', 'locations'], ['exportPages', 'pages'],
    ].forEach(function (pair) {
      var el = $(pair[0]);
      if (el) el.href = '/api/admin/analytics/export?dataset=' + pair[1] + '&' + q;
    });
  }

  // ---------- Período ----------
  function bindPeriodSelector() {
    var row = $('periodRow');
    row.querySelectorAll('.az-period-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        row.querySelectorAll('.az-period-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var range = btn.dataset.range;
        if (range === 'custom') {
          $('customRange').style.display = 'inline-flex';
          return; // espera o "Aplicar"
        }
        $('customRange').style.display = 'none';
        state.range = range;
        loadAll();
      });
    });
    $('customApply').addEventListener('click', function () {
      var from = $('customFrom').value;
      var to = $('customTo').value;
      if (!from || !to) return;
      state.range = 'custom';
      state.from = from;
      state.to = to;
      loadAll();
    });
  }

  async function loadAll() {
    updateExportLinks();
    var tasks = [loadOverview(), loadTimeseries(), loadSources(), loadDevices(), loadLocations(), loadProducts(), loadCategories(), loadPages(), loadHours()];
    var results = await Promise.allSettled(tasks);
    var firstError = results.find(function (r) { return r.status === 'rejected'; });
    if (firstError) window.RshoesAdmin.toast('Não deu pra carregar alguns dados do Analytics.', true);
  }

  async function init() {
    var admin = await window.RshoesAdmin.guard();
    if (!admin) return;
    window.RshoesAdmin.bindLogout();

    bindPeriodSelector();
    bindSettingsToggle();
    $('tsMetric').addEventListener('change', renderTimeseriesChart);

    loadSettings().catch(function () {});
    loadRealtime();
    realtimeTimer = setInterval(loadRealtime, 15000);
    overviewTimer = setInterval(loadOverview, 60000);

    await loadAll();
  }

  window.addEventListener('beforeunload', function () {
    clearInterval(realtimeTimer);
    clearInterval(overviewTimer);
  });

  init();
})();

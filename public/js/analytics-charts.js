// Gráficos leves em SVG puro para o Analytics — sem biblioteca externa
// (o projeto não tinha nenhuma lib de gráficos instalada; para os tipos de
// visualização pedidos, SVG nativo é mais leve que trazer uma dependência
// nova e continua responsivo via viewBox).
window.RshoesCharts = (function () {
  'use strict';

  var PALETTE = ['#ff5a1f', '#ffb020', '#c22b1f', '#f7f1e8', '#a89e91', '#ff2d2d', '#ffd23f'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtCompact(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.0', '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'k';
    return String(Math.round(n));
  }

  // ---------- Linha (multi-série) ----------
  // series: [{ name, color, data: number[] }], labels: string[] (mesmo tamanho de data)
  function lineChart(labels, series, opts) {
    opts = opts || {};
    var W = opts.width || 640, H = opts.height || 220;
    var padL = 34, padR = 12, padT = 14, padB = 26;
    var innerW = W - padL - padR, innerH = H - padT - padB;
    var n = labels.length;
    var max = 0;
    series.forEach(function (s) { s.data.forEach(function (v) { if (v > max) max = v; }); });
    if (max === 0) max = 1;
    var niceMax = Math.ceil(max * 1.15);

    function x(i) { return padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW); }
    function y(v) { return padT + innerH - (v / niceMax) * innerH; }

    var gridLines = '';
    var steps = 4;
    for (var g = 0; g <= steps; g++) {
      var gv = (niceMax / steps) * g;
      var gy = y(gv);
      gridLines += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + gy + '" y2="' + gy + '" stroke="var(--line)" stroke-width="1"/>';
      gridLines += '<text x="' + (padL - 8) + '" y="' + (gy + 3) + '" text-anchor="end" font-size="9" fill="var(--grey)" font-family="var(--font-body)">' + fmtCompact(gv) + '</text>';
    }

    var labelStep = Math.max(1, Math.ceil(n / 7));
    var xLabels = '';
    for (var i = 0; i < n; i += labelStep) {
      xLabels += '<text x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="9" fill="var(--grey)" font-family="var(--font-body)">' + esc(labels[i]) + '</text>';
    }

    var paths = series.map(function (s, si) {
      var color = s.color || PALETTE[si % PALETTE.length];
      var d = s.data.map(function (v, i) { return (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
      var lastX = x(n - 1), lastY = y(s.data[n - 1] || 0);
      return (
        '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<circle cx="' + lastX + '" cy="' + lastY + '" r="3" fill="' + color + '"/>'
      );
    }).join('');

    return (
      '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">' +
      gridLines + xLabels + paths +
      '</svg>'
    );
  }

  // ---------- Barras (histograma simples) ----------
  function barChart(labels, values, opts) {
    opts = opts || {};
    var W = opts.width || 640, H = opts.height || 180;
    var padL = 8, padR = 8, padT = 10, padB = 22;
    var innerW = W - padL - padR, innerH = H - padT - padB;
    var n = values.length;
    var max = Math.max.apply(null, values.concat([1]));
    var gap = 4;
    var barW = Math.max(2, innerW / n - gap);
    var color = opts.color || 'var(--gold)';

    var bars = '';
    var xLabels = '';
    var labelStep = Math.max(1, Math.ceil(n / 12));
    for (var i = 0; i < n; i++) {
      var h = max > 0 ? (values[i] / max) * innerH : 0;
      var bx = padL + i * (barW + gap);
      var by = padT + innerH - h;
      bars += '<rect x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(1, h).toFixed(1) + '" fill="' + color + '" rx="1"/>';
      if (i % labelStep === 0) {
        xLabels += '<text x="' + (bx + barW / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="9" fill="var(--grey)" font-family="var(--font-body)">' + esc(labels[i]) + '</text>';
      }
    }

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">' + bars + xLabels + '</svg>';
  }

  // ---------- Donut ----------
  // data: [{ label, value }]
  function donutChart(data, opts) {
    opts = opts || {};
    var size = opts.size || 160;
    var r = size / 2 - 14;
    var cx = size / 2, cy = size / 2;
    var circumference = 2 * Math.PI * r;
    var total = data.reduce(function (s, d) { return s + Number(d.value || 0); }, 0);

    if (total <= 0) {
      return (
        '<svg viewBox="0 0 ' + size + ' ' + size + '" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="var(--line)" stroke-width="16"/>' +
        '</svg>'
      );
    }

    var offset = 0;
    var segments = data.map(function (d, i) {
      var frac = Number(d.value || 0) / total;
      var len = frac * circumference;
      var seg = (
        '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + (d.color || PALETTE[i % PALETTE.length]) + '" ' +
        'stroke-width="16" stroke-dasharray="' + len.toFixed(2) + ' ' + (circumference - len).toFixed(2) + '" ' +
        'stroke-dashoffset="' + (-offset).toFixed(2) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>'
      );
      offset += len;
      return seg;
    }).join('');

    return '<svg viewBox="0 0 ' + size + ' ' + size + '" xmlns="http://www.w3.org/2000/svg">' + segments + '</svg>';
  }

  return { lineChart: lineChart, barChart: barChart, donutChart: donutChart, palette: PALETTE, fmtCompact: fmtCompact };
})();

// Moderação dos feedbacks enviados pelos clientes (aprovar / rejeitar / excluir).
(function () {
  'use strict';
  var A = window.RshoesAdmin, api = window.RshoesApi, esc = A.escapeHtml;
  var current = 'pending';
  var LABEL = { pending: 'Pendente', approved: 'Aprovado', rejected: 'Rejeitado' };
  var COLOR = { pending: '#e0b341', approved: '#3fae6a', rejected: '#e05a5a' };

  function fmtDate(iso) { var p = String(iso || '').slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : '-'; }
  function fmtDateTime(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '-' : d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function row(f) {
    var thumb = f.media_type === 'video'
      ? '<video src="' + esc(f.media_url) + '#t=0.1" preload="metadata" muted playsinline style="width:64px;height:64px;object-fit:cover;border-radius:4px"></video>'
      : '<img class="thumb" src="' + esc(f.media_url) + '" alt="" style="width:64px;height:64px">';
    var btn = function (status, text, cls) {
      return f.status === status ? '' : '<button type="button" class="btn ' + cls + '" data-act="' + status + '" data-id="' + f.id + '" style="padding:6px 10px;font-size:.75rem">' + text + '</button>';
    };
    return '<tr>' +
      '<td><a href="' + esc(f.media_url) + '" target="_blank" rel="noopener">' + thumb + '</a></td>' +
      '<td>' + esc(f.name) + '</td>' +
      '<td>' + esc(f.product_name) + '</td>' +
      '<td>' + fmtDate(f.purchase_date) + '</td>' +
      '<td>' + fmtDateTime(f.created_at) + '</td>' +
      '<td><span style="color:' + COLOR[f.status] + ';font-weight:600">' + (LABEL[f.status] || f.status) + '</span></td>' +
      '<td><div style="display:flex;gap:6px;flex-wrap:wrap">' +
        btn('approved', 'Aprovar', 'btn-gold') + btn('rejected', 'Rejeitar', 'btn-ghost') +
        '<button type="button" class="btn btn-ghost" data-del="' + f.id + '" style="padding:6px 10px;font-size:.75rem;color:#e05a5a">Excluir</button>' +
      '</div></td></tr>';
  }

  async function load() {
    var body = document.getElementById('fbBody');
    try {
      var data = await api.get('/admin/feedbacks' + (current ? '?status=' + current : ''));
      var c = data.counts || {};
      ['pending', 'approved', 'rejected'].forEach(function (k) {
        document.getElementById('cnt-' + k).textContent = c[k] ? '(' + c[k] + ')' : '';
      });
      body.innerHTML = data.feedbacks.length
        ? data.feedbacks.map(row).join('')
        : '<tr><td colspan="7">Nenhum feedback aqui por enquanto.</td></tr>';
    } catch (err) {
      body.innerHTML = '<tr><td colspan="7">Não deu pra carregar os feedbacks.</td></tr>';
      A.toast(err.message, true);
    }
  }

  document.getElementById('fbTabs').addEventListener('click', function (e) {
    var b = e.target.closest('[data-status]');
    if (!b) return;
    current = b.dataset.status;
    document.querySelectorAll('#fbTabs [data-status]').forEach(function (x) {
      x.className = 'btn ' + (x === b ? 'btn-gold' : 'btn-ghost');
    });
    load();
  });

  document.getElementById('fbBody').addEventListener('click', async function (e) {
    var act = e.target.closest('[data-act]'), del = e.target.closest('[data-del]');
    try {
      if (act) {
        await api.patch('/admin/feedbacks/' + act.dataset.id, { status: act.dataset.act });
        A.toast(act.dataset.act === 'approved' ? 'Feedback aprovado. Já aparece no site.' : 'Feedback rejeitado.');
        load();
      } else if (del) {
        if (!confirm('Excluir esse feedback e a mídia dele? Não dá pra desfazer.')) return;
        await api.del('/admin/feedbacks/' + del.dataset.del);
        A.toast('Feedback excluído.');
        load();
      }
    } catch (err) { A.toast(err.message, true); }
  });

  A.bindLogout();
  A.guard().then(function (admin) { if (admin) load(); });
})();

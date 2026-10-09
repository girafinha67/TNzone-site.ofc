(function () {
  'use strict';

  var esc = window.RshoesAdmin.escapeHtml;
  var content = null;

  function topbarRowHtml(text, i) {
    return '<div class="repeat-row" data-i="' + i + '">' +
      '<button type="button" class="row-remove" data-remove="topbar">✕</button>' +
      '<div class="form-field full"><label>Aviso ' + (i + 1) + '</label>' +
      '<input type="text" data-field="topbar" value="' + esc(text) + '"></div>' +
    '</div>';
  }

  function heroRowHtml(slide, i) {
    slide = slide || {};
    return '<div class="repeat-row" data-i="' + i + '">' +
      '<button type="button" class="row-remove" data-remove="hero">✕</button>' +
      '<div class="form-field full"><label>Imagem ' + (i + 1) + ' (URL)</label><input type="text" data-hf="image" value="' + esc(slide.image) + '" placeholder="https://..."></div>' +
      '<div class="form-field full"><label>Link ao clicar (opcional)</label><input type="text" data-hf="link" value="' + esc(slide.link) + '" placeholder="/catalogo.html?brand=Nike"></div>' +
    '</div>';
  }

  function benefitRowHtml(b, i) {
    b = b || {};
    return '<div class="repeat-row" data-i="' + i + '">' +
      '<button type="button" class="row-remove" data-remove="benefit">✕</button>' +
      '<div class="two-col">' +
        '<div class="form-field full"><label>Ícone (emoji)</label><input type="text" data-bf="icon" value="' + esc(b.icon) + '" maxlength="4"></div>' +
        '<div class="form-field full"><label>Título</label><input type="text" data-bf="title" value="' + esc(b.title) + '"></div>' +
      '</div>' +
      '<div class="form-field full"><label>Texto</label><input type="text" data-bf="text" value="' + esc(b.text) + '"></div>' +
    '</div>';
  }

  function renderAll() {
    document.getElementById('topbarRows').innerHTML = (content.topbar || []).map(topbarRowHtml).join('');
    document.getElementById('heroRows').innerHTML = (content.hero || []).map(heroRowHtml).join('');
    document.getElementById('benefitRows').innerHTML = (content.benefits || []).map(benefitRowHtml).join('');
    var pb = content.promoBanner || {};
    document.getElementById('promoActive').checked = !!pb.active;
    document.getElementById('promoEyebrow').value = pb.eyebrow || '';
    document.getElementById('promoTitle').value = pb.title || '';
    document.getElementById('promoSubtitle').value = pb.subtitle || '';
    document.getElementById('promoCtaLabel').value = pb.ctaLabel || '';
    document.getElementById('promoCtaLink').value = pb.ctaLink || '';
  }

  function readFormIntoContent() {
    content.topbar = Array.from(document.querySelectorAll('#topbarRows [data-field="topbar"]')).map(function (el) { return el.value.trim(); }).filter(Boolean);
    content.hero = Array.from(document.querySelectorAll('#heroRows .repeat-row')).map(function (row) {
      var el = row.querySelector('[data-hf="image"]');
      var lk = row.querySelector('[data-hf="link"]');
      var slide = { image: el ? el.value.trim() : '' };
      if (lk && lk.value.trim()) slide.link = lk.value.trim();
      return slide;
    });
    content.benefits = Array.from(document.querySelectorAll('#benefitRows .repeat-row')).map(function (row) {
      var get = function (f) { var el = row.querySelector('[data-bf="' + f + '"]'); return el ? el.value.trim() : ''; };
      return { icon: get('icon'), title: get('title'), text: get('text') };
    }).filter(function (b) { return b.title; });
    content.promoBanner = {
      active: document.getElementById('promoActive').checked,
      eyebrow: document.getElementById('promoEyebrow').value.trim(),
      title: document.getElementById('promoTitle').value.trim(),
      subtitle: document.getElementById('promoSubtitle').value.trim(),
      ctaLabel: document.getElementById('promoCtaLabel').value.trim(),
      ctaLink: document.getElementById('promoCtaLink').value.trim(),
    };
  }

  document.getElementById('addTopbar').addEventListener('click', function () {
    content.topbar = content.topbar || []; content.topbar.push(''); renderAll();
  });
  document.getElementById('addHero').addEventListener('click', function () {
    content.hero = content.hero || []; content.hero.push({}); renderAll();
  });
  document.getElementById('addBenefit').addEventListener('click', function () {
    content.benefits = content.benefits || []; content.benefits.push({}); renderAll();
  });

  document.getElementById('contentForm').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-remove]');
    if (!btn) return;
    var row = btn.closest('.repeat-row');
    var i = Number(row.dataset.i);
    var key = btn.dataset.remove === 'topbar' ? 'topbar' : (btn.dataset.remove === 'hero' ? 'hero' : 'benefits');
    readFormIntoContent();
    content[key].splice(i, 1);
    renderAll();
  });

  document.getElementById('contentForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    readFormIntoContent();
    var btn = document.getElementById('saveBtn');
    btn.disabled = true; btn.textContent = 'Salvando…';
    try {
      var res = await window.RshoesApi.put('/admin/settings/home', content);
      content = res.content;
      renderAll();
      window.RshoesAdmin.toast('Conteúdo da home atualizado.');
    } catch (err) {
      window.RshoesAdmin.toast(err.message || 'Não deu pra salvar.', true);
    } finally {
      btn.disabled = false; btn.textContent = 'Salvar alterações';
    }
  });

  async function init() {
    await window.RshoesAdmin.guard();
    window.RshoesAdmin.bindLogout();
    try {
      content = await window.RshoesApi.get('/settings/home');
      document.getElementById('loadingMsg').style.display = 'none';
      document.getElementById('contentForm').style.display = 'block';
      renderAll();
    } catch (err) {
      document.getElementById('loadingMsg').textContent = 'Não foi possível carregar o conteúdo da home.';
    }
  }

  init();
})();

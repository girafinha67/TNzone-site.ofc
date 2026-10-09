// Seção "Quem comprou, aprovou": lista os feedbacks aprovados e permite o cliente
// enviar o dele (foto ou vídeo) para aprovação no painel.
(function () {
  'use strict';
  var track = document.getElementById('fbTrack');
  if (!track) return;

  var $ = function (id) { return document.getElementById(id); };
  var modal = $('fbModal'), form = $('fbForm');
  var fileInput = $('fbFile'), chosen = null, previewUrl = null, busy = false;

  var MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
  var IMG_MAX = 8 * 1024 * 1024, VID_MAX = 50 * 1024 * 1024;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(iso) { var p = String(iso).slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : ''; }

  // ---------- lista ----------
  function render(list) {
    if (!list.length) {
      track.innerHTML = '<p class="fb-empty">Ainda não tem feedback por aqui. Seja o primeiro a mandar o seu!</p>';
      $('fbHint').hidden = true;
      return;
    }
    track.innerHTML = list.map(function (f) {
      var media = f.media_type === 'video'
        ? '<video src="' + esc(f.media_url) + '#t=0.1" controls playsinline preload="metadata"></video>'
        : '<img src="' + esc(f.media_url) + '" alt="Feedback de ' + esc(f.name) + '" loading="lazy">';
      return '<article class="fb-card"><div class="fb-media">' + media + '</div>' +
        '<div class="fb-cap"><strong>' + esc(f.name) + '</strong><span>' + esc(f.product_name) + '</span>' +
        '<span>Compra em ' + fmtDate(f.purchase_date) + '</span></div></article>';
    }).join('');
    $('fbHint').hidden = list.length < 2;
  }
  function load() {
    fetch('/api/feedbacks', { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) { render((d && d.feedbacks) || []); })
      .catch(function () { render([]); });
  }

  // ---------- modal ----------
  function showError(msg) { var e = $('fbError'); e.textContent = msg || ''; e.hidden = !msg; }
  function resetForm() {
    form.reset(); chosen = null; busy = false; showError('');
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    $('fbPreview').hidden = true; $('fbPreview').innerHTML = '';
    $('fbFileText').textContent = 'Toque para escolher (foto até 8 MB, vídeo até 50 MB)';
    $('fbProgress').hidden = true; $('fbBar').style.width = '0';
    $('fbSubmit').disabled = false; $('fbSubmit').textContent = 'ENVIAR FEEDBACK';
    $('fbFormView').hidden = false; $('fbDoneView').hidden = true;
  }
  function openModal() {
    resetForm();
    var d = new Date(), pad = function (n) { return String(n).padStart(2, '0'); };
    var today = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    $('fbDate').max = today;
    $('fbDate').min = (d.getFullYear() - 5) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    modal.hidden = false; document.body.style.overflow = 'hidden';
    setTimeout(function () { $('fbName').focus(); }, 50);
  }
  function closeModal() {
    if (busy) return;
    modal.hidden = true; document.body.style.overflow = '';
    if ($('fbDoneView').hidden === false) load();
  }
  $('fbOpen').addEventListener('click', openModal);
  modal.addEventListener('click', function (e) { if (e.target.hasAttribute('data-fb-close')) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

  function fileMime(f) {
    if (f.type && /^(image|video)\//.test(f.type)) return f.type === 'video/x-m4v' ? 'video/mp4' : f.type;
    var ext = (f.name.split('.').pop() || '').toLowerCase();
    return MIME_BY_EXT[ext] || '';
  }

  fileInput.addEventListener('change', function () {
    showError('');
    var f = fileInput.files && fileInput.files[0];
    if (!f) return;
    var mime = fileMime(f);
    if (!mime || !Object.values(MIME_BY_EXT).includes(mime)) { showError('Esse formato não é aceito. Envie foto (JPG, PNG, WEBP) ou vídeo (MP4, MOV, WEBM).'); fileInput.value = ''; return; }
    var isVideo = mime.indexOf('video/') === 0;
    if (f.size > (isVideo ? VID_MAX : IMG_MAX)) { showError(isVideo ? 'O vídeo pode ter no máximo 50 MB.' : 'A foto pode ter no máximo 8 MB.'); fileInput.value = ''; return; }
    chosen = { file: f, mime: mime, isVideo: isVideo };
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(f);
    $('fbPreview').innerHTML = isVideo ? '<video src="' + previewUrl + '" controls playsinline muted></video>' : '<img src="' + previewUrl + '" alt="Prévia">';
    $('fbPreview').hidden = false;
    $('fbFileText').textContent = 'Trocar arquivo (' + f.name + ')';
  });

  function api(path, body) {
    return fetch('/api' + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw new Error(d.error || 'Não deu pra enviar agora. Tenta de novo.');
          return d;
        });
      });
  }
  function putFile(url, file, mime) {
    return new Promise(function (resolve, reject) {
      var fd = new FormData();
      fd.append('cacheControl', '31536000');
      fd.append('', new File([file], file.name || 'arquivo', { type: mime }));
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) $('fbBar').style.width = Math.round((e.loaded / e.total) * 100) + '%'; };
      xhr.onload = function () { xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('Não deu pra enviar o arquivo. Tenta de novo.')); };
      xhr.onerror = function () { reject(new Error('Sem conexão. Confere a internet e tenta de novo.')); };
      xhr.send(fd);
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var name = $('fbName').value.trim().replace(/\s+/g, ' ');
    var product = $('fbProduct').value.trim();
    var date = $('fbDate').value;
    if (name.split(' ').filter(function (w) { return w.length >= 2; }).length < 2) return showError('Coloque seu nome completo (nome e sobrenome).');
    if (product.length < 2) return showError('Coloque o nome do produto que você comprou.');
    if (!date) return showError('Escolha a data da compra.');
    if (date > $('fbDate').max) return showError('A data da compra não pode ser no futuro.');
    if (!chosen) return showError('Escolha uma foto ou vídeo do seu pedido.');

    busy = true; showError('');
    $('fbSubmit').disabled = true; $('fbSubmit').textContent = 'ENVIANDO…';
    $('fbProgress').hidden = false; $('fbBar').style.width = '0';
    var target;
    api('/feedbacks/upload-url', { mime: chosen.mime, size: chosen.file.size })
      .then(function (t) { target = t; return putFile(t.signedUrl, chosen.file, chosen.mime); })
      .then(function () {
        return api('/feedbacks', { name: name, product_name: product, purchase_date: date, media_url: target.publicUrl, media_type: target.kind });
      })
      .then(function () {
        busy = false;
        $('fbFormView').hidden = true; $('fbDoneView').hidden = false;
      })
      .catch(function (err) {
        busy = false;
        showError(err.message);
        $('fbSubmit').disabled = false; $('fbSubmit').textContent = 'ENVIAR FEEDBACK';
        $('fbProgress').hidden = true;
      });
  });

  load();
})();

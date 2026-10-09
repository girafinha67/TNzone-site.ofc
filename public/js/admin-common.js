// Utilitários compartilhados por todas as páginas do painel admin.
// Toda página admin.html chama window.RshoesAdmin.guard() antes de renderizar
// qualquer dado — o backend também bloqueia (netlify/functions/api.js), isso
// aqui é só para não piscar UI de admin para quem não está logado.
window.RshoesAdmin = (function () {
  'use strict';

  async function guard() {
    try {
      const data = await window.RshoesApi.get('/auth/me');
      const emailEl = document.getElementById('adminEmail');
      if (emailEl) emailEl.textContent = data.admin.email;
      return data.admin;
    } catch (err) {
      window.location.href = 'login.html';
      return null;
    }
  }

  function toast(message, isError) {
    let el = document.getElementById('rshoesToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rshoesToast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function bindLogout() {
    const btn = document.getElementById('logoutBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      try {
        await window.RshoesApi.post('/auth/logout');
      } finally {
        window.location.href = '../index.html';
      }
    });
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  return { guard, toast, bindLogout, escapeHtml };
})();

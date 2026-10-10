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

  // ---------- Mobile: menu em gaveta (☰) ----------
  // Injeta a barra superior + botão de menu e controla a gaveta lateral.
  // Em telas > 860px nada disso aparece (o CSS esconde).
  function initMobileNav() {
    const sidebar = document.querySelector('.admin-sidebar');
    const shell = document.querySelector('.admin-shell');
    if (!sidebar || !shell || document.querySelector('.admin-mobilebar')) return;

    sidebar.id = sidebar.id || 'adminSidebar';

    const bar = document.createElement('header');
    bar.className = 'admin-mobilebar';
    bar.innerHTML =
      '<button type="button" class="admin-menu-btn" aria-label="Abrir menu" aria-expanded="false" aria-controls="' + sidebar.id + '">' +
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>' +
      '</button>' +
      '<span class="admin-mobilebar-title">TN\'zone <em>Admin</em></span>';
    shell.parentNode.insertBefore(bar, shell);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'admin-drawer-close';
    closeBtn.setAttribute('aria-label', 'Fechar menu');
    closeBtn.innerHTML = '&times;';
    sidebar.appendChild(closeBtn);

    const backdrop = document.createElement('div');
    backdrop.className = 'admin-drawer-backdrop';
    document.body.appendChild(backdrop);

    const menuBtn = bar.querySelector('.admin-menu-btn');
    const mq = window.matchMedia('(max-width: 860px)');

    function setOpen(open) {
      sidebar.classList.toggle('open', open);
      backdrop.classList.toggle('open', open);
      document.body.classList.toggle('admin-drawer-open', open);
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        const first = sidebar.querySelector('.admin-nav a');
        if (first) first.focus({ preventScroll: true });
      }
    }

    menuBtn.addEventListener('click', () => setOpen(true));
    closeBtn.addEventListener('click', () => { setOpen(false); menuBtn.focus({ preventScroll: true }); });
    backdrop.addEventListener('click', () => setOpen(false));
    sidebar.addEventListener('click', (e) => {
      // Fecha ao tocar num link (a página troca; "Sair" também).
      if (e.target.closest('.admin-nav a')) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sidebar.classList.contains('open')) {
        setOpen(false);
        menuBtn.focus({ preventScroll: true });
      }
    });
    const onChange = (e) => { if (!e.matches) setOpen(false); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  // ---------- Mobile: tabelas viram cards ----------
  // Copia o texto de cada <th> para o data-label da célula correspondente; o CSS
  // (<= 640px) usa esse rótulo para mostrar "Campo: valor" em cada card. Re-roda
  // sozinho toda vez que o JS da página redesenha o <tbody>.
  function initTableLabels() {
    document.querySelectorAll('table.admin-table').forEach((table) => {
      const heads = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim());
      const tbody = table.tBodies[0];
      if (!heads.length || !tbody) return;
      const apply = () => {
        tbody.querySelectorAll('tr').forEach((tr) => {
          Array.from(tr.children).forEach((td, i) => {
            if (td.tagName === 'TD' && !td.hasAttribute('colspan') && !td.hasAttribute('data-label') && heads[i]) {
              td.setAttribute('data-label', heads[i]);
            }
          });
        });
      };
      apply();
      new MutationObserver(apply).observe(tbody, { childList: true });
    });
  }

  function initMobile() {
    initMobileNav();
    initTableLabels();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initMobile);
  else initMobile();

  return { guard, toast, bindLogout, escapeHtml };
})();

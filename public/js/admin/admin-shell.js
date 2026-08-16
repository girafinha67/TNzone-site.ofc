// admin-shell.js — protege rotas admin e monta a sidebar. Incluir em toda página /admin/*.html (exceto login).

const ADMIN_NAV = [
  { href: '/admin/dashboard', label: 'Dashboard', ic: '◱' },
  { href: '/admin/produtos', label: 'Produtos', ic: '👟' },
  { href: '/admin/categorias', label: 'Categorias', ic: '🗂' },
  { href: '/admin/pagina-inicial', label: 'Página inicial', ic: '🏠' },
  { href: '/admin/feedbacks', label: 'Feedbacks', ic: '💬' },
  { href: '/admin/configuracoes', label: 'Configurações', ic: '⚙' },
];

async function guardAdmin() {
  try {
    const { admin } = await API.get('/api/auth/me');
    return admin;
  } catch {
    location.href = '/admin/login';
    return null;
  }
}

function renderAdminSidebar(activeHref, admin) {
  const el = document.getElementById('admin-sidebar');
  if (!el) return;
  el.innerHTML = `
    <div class="logo"><span class="dot"></span> TN Zone <span style="color:var(--text-faint);font-weight:500;font-size:12px;">admin</span></div>
    ${ADMIN_NAV.map(item => `
      <a href="${item.href}" class="admin-nav-link ${activeHref === item.href ? 'active' : ''}">
        <span class="ic">${item.ic}</span> ${item.label}
      </a>
    `).join('')}
    <div class="spacer"></div>
    <a href="/" class="admin-nav-link" target="_blank"><span class="ic">↗</span> Ver site</a>
    <div class="admin-user">
      ${admin ? escapeHtml(admin.email) : ''}
      <br>
      <a href="#" id="logout-link" style="color:var(--danger);font-weight:600;">Sair</a>
    </div>
  `;
  document.getElementById('logout-link')?.addEventListener('click', async (e) => {
    e.preventDefault();
    await API.post('/api/auth/logout');
    location.href = '/admin/login';
  });
}

async function initAdminPage(activeHref) {
  const admin = await guardAdmin();
  if (!admin) return null;
  renderAdminSidebar(activeHref, admin);
  setupMobileNav();
  return admin;
}

// Modal de confirmação visual, consistente com o resto do painel — substitui
// o confirm() nativo do navegador (que foge do design e é bloqueado por
// alguns navegadores/mobile em iframes). Retorna uma Promise<boolean>.
function adminConfirm(message, { title = 'Confirmar ação', confirmLabel = 'Confirmar', danger = true } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card glass" style="max-width:420px;" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h3 id="confirm-title">${escapeHtml(title)}</h3>
        <p style="color:var(--text-dim);font-size:14px;line-height:1.6;">${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="confirm-cancel">Cancelar</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirm-ok">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    function cleanup(result) {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') cleanup(false);
    }

    overlay.querySelector('#confirm-cancel').addEventListener('click', () => cleanup(false));
    overlay.querySelector('#confirm-ok').addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    document.addEventListener('keydown', onKeydown);
    overlay.querySelector('#confirm-ok').focus();
  });
}

// Cria o botão de menu (☰) e a gaveta lateral usada em telas pequenas.
// Funciona em qualquer página que tenha .admin-shell + #admin-sidebar,
// sem precisar editar o HTML de cada página.
function setupMobileNav() {
  const shell = document.querySelector('.admin-shell');
  const sidebar = document.getElementById('admin-sidebar');
  if (!shell || !sidebar || document.querySelector('.admin-mobile-topbar')) return;

  const topbar = document.createElement('div');
  topbar.className = 'admin-mobile-topbar';
  topbar.innerHTML = `
    <button class="icon-btn" id="mobile-menu-btn" aria-label="Abrir menu">☰</button>
    <div class="logo" style="font-size:15px;"><span class="dot"></span> TN Zone <span style="color:var(--text-faint);font-weight:500;font-size:11px;">admin</span></div>
  `;
  shell.prepend(topbar);

  const overlay = document.createElement('div');
  overlay.className = 'admin-overlay-bg';
  shell.appendChild(overlay);

  function openMenu() { sidebar.classList.add('open'); overlay.classList.add('open'); }
  function closeMenu() { sidebar.classList.remove('open'); overlay.classList.remove('open'); }

  document.getElementById('mobile-menu-btn').addEventListener('click', openMenu);
  overlay.addEventListener('click', closeMenu);
  sidebar.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeMenu));
}

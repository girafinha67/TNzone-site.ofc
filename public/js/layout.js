// layout.js — monta header/footer dinâmicos em qualquer página pública que
// tenha <div id="site-header"></div> e <div id="site-footer"></div>.

async function renderLayout(activePage) {
  const headerEl = document.getElementById('site-header');
  const footerEl = document.getElementById('site-footer');
  if (!headerEl && !footerEl) return;

  let settings = {};
  let categories = [];
  try {
    const [s, c] = await Promise.all([API.get('/api/settings'), API.get('/api/categories')]);
    settings = s.settings || {};
    categories = c.categories || [];
  } catch { /* segue com defaults */ }

  const storeName = settings.store_name || 'TNzone';
  const storeSub = settings.store_subtitle || 'ATACADO E VAREJO · SÃO LUÍS — MA';
  const logoSrc = escapeHtml(settings.logo_url || '/img/logo-mark.png');
  if (headerEl) {
    headerEl.innerHTML = `
      <header class="site-header">
        <div class="header-inner container">
          <a href="/" class="logo">
            <img src="${logoSrc}" alt="${escapeHtml(storeName)}">
            <span class="logo-text">
              <span class="logo-name">${escapeHtml(storeName)}</span>
              <span class="logo-sub">${escapeHtml(storeSub)}</span>
            </span>
          </a>
          <nav class="main-nav" id="main-nav">
            <a href="/" class="${activePage === 'home' ? 'active' : ''}">Início</a>
            <a href="/catalogo" class="${activePage === 'catalogo' ? 'active' : ''}">Catálogo</a>
            ${categories.slice(0, 3).map(c => `<a href="/catalogo?category=${encodeURIComponent(c.slug)}">${escapeHtml(c.name)}</a>`).join('')}
            <a href="/sobre" class="${activePage === 'sobre' ? 'active' : ''}">Sobre</a>
            <a href="/contato" class="${activePage === 'contato' ? 'active' : ''}">Contato</a>
          </nav>
          <div class="header-actions">
            <button class="nav-toggle" id="nav-toggle" aria-label="Abrir menu" aria-expanded="false" aria-controls="main-nav">☰</button>
          </div>
        </div>
      </header>
      <div class="nav-overlay-bg" id="nav-overlay-bg"></div>
    `;

    const nav = document.getElementById('main-nav');
    const toggle = document.getElementById('nav-toggle');
    const overlay = document.getElementById('nav-overlay-bg');
    function openNav() {
      nav.classList.add('open');
      overlay.classList.add('open');
      toggle.textContent = '✕';
      toggle.setAttribute('aria-expanded', 'true');
    }
    function closeNav() {
      nav.classList.remove('open');
      overlay.classList.remove('open');
      toggle.textContent = '☰';
      toggle.setAttribute('aria-expanded', 'false');
    }
    toggle.addEventListener('click', () => (nav.classList.contains('open') ? closeNav() : openNav()));
    overlay.addEventListener('click', closeNav);
    nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeNav));
  }

  if (footerEl) {
    footerEl.innerHTML = `
      <footer class="site-footer">
        <div class="container">
          <div class="footer-grid">
            <div class="footer-col">
              <div class="logo" style="margin-bottom:12px;">
                <img src="${logoSrc}" alt="${escapeHtml(storeName)}">
                ${escapeHtml(storeName)}
              </div>
              <p>${escapeHtml(settings.footer_text || '')}</p>
            </div>
            <div class="footer-col">
              <h4>Loja</h4>
              <a href="/">Início</a>
              <a href="/catalogo">Catálogo</a>
              <a href="/sobre">Sobre nós</a>
              <a href="/feedbacks">Avaliações</a>
            </div>
            <div class="footer-col">
              <h4>Contato</h4>
              <a href="/contato">Fale com a gente</a>
              ${settings.instagram ? `<a href="https://instagram.com/${escapeHtml(settings.instagram.replace('@',''))}" target="_blank" rel="noopener">@${escapeHtml(settings.instagram.replace('@',''))}</a>` : ''}
              ${settings.whatsapp_number ? `<a href="https://wa.me/${escapeHtml(settings.whatsapp_number)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
              ${settings.email_contact ? `<a href="mailto:${escapeHtml(settings.email_contact)}">${escapeHtml(settings.email_contact)}</a>` : ''}
            </div>
          </div>
          <div class="footer-bottom">
            <span>© ${new Date().getFullYear()} ${escapeHtml(storeName)}. Todos os direitos reservados.</span>
            <a href="/admin/login" class="footer-admin-link">Admin</a>
          </div>
        </div>
      </footer>
    `;
  }

  // Botão flutuante do WhatsApp (presente em todas as páginas públicas)
  if (!document.querySelector('.wa-float')) {
    const waNumber = escapeHtml(settings.whatsapp_number || '5561986553995');
    const waMsg = encodeURIComponent('Olá! Vim pelo site da TNzone e queria saber mais sobre os produtos.');
    const wa = document.createElement('a');
    wa.className = 'wa-float';
    wa.href = `https://wa.me/${waNumber}?text=${waMsg}`;
    wa.target = '_blank';
    wa.rel = 'noopener';
    wa.setAttribute('aria-label', 'Falar no WhatsApp');
    wa.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.15h-.01a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.11.82.83-3.03-.2-.31a8.23 8.23 0 0 1-1.26-4.39c0-4.54 3.7-8.24 8.24-8.24 2.2 0 4.27.86 5.83 2.42a8.19 8.19 0 0 1 2.41 5.83c0 4.54-3.7 8.24-8.24 8.24Zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.16.25-.64.81-.78.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.12-.14.16-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.23.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.07.14-1.18-.06-.11-.22-.17-.47-.29Z"/></svg>`;
    document.body.appendChild(wa);
  }
}

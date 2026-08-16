function productCardHtml(p) {
  const img = p.images && p.images[0] ? p.images[0] : null;
  const outOfStock = p.stock <= 0;
  const catLabel = { tenis: 'Tênis', camisa: 'Camisa', calca: 'Calça', outro: 'Produto' }[p.type] || '';
  // Pill de desconto no estilo da referência ("ATÉ 48% OFF").
  let promoPct = 0;
  if (p.promo_price && p.price && p.promo_price < p.price) {
    promoPct = Math.round((1 - p.promo_price / p.price) * 100);
  }
  return `
    <div class="product-card glass">
      <a href="/produto?slug=${encodeURIComponent(p.slug)}" class="product-media">
        ${img ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(p.name)}" loading="lazy">` : '<div class="placeholder">Sem foto</div>'}
        ${p.featured ? '<span class="badge promo">Novidade</span>' : ''}
        ${outOfStock ? '<span class="badge out" style="left:auto;right:12px;">Esgotado</span>' : ''}
      </a>
      <div class="product-info">
        <div class="cat">${catLabel}</div>
        <a href="/produto?slug=${encodeURIComponent(p.slug)}" class="name">${escapeHtml(p.name)}</a>
        <div class="price-row">
          <span class="now">${money(p.promo_price || p.price)}</span>
          ${p.promo_price ? `<span class="old">${money(p.price)}</span>` : ''}
        </div>
        ${promoPct > 0 ? `<span class="promo-pill">Até ${promoPct}% OFF</span>` : ''}
        <div class="product-actions">
          <a href="/produto?slug=${encodeURIComponent(p.slug)}" class="btn btn-ghost btn-sm">Detalhes</a>
          <button class="btn btn-whatsapp btn-sm" ${outOfStock ? 'disabled' : ''} onclick='openWhatsappForProduct(${JSON.stringify(p).replace(/'/g, "&#39;")})'>Comprar</button>
        </div>
      </div>
    </div>
  `;
}

function renderProductGrid(elementId, products) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (!products.length) {
    el.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="big">🛍️</div>Nenhum produto encontrado.</div>';
    return;
  }
  el.innerHTML = products.map(productCardHtml).join('');
}

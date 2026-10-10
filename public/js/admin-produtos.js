(function () {
  'use strict';

  let products = [];
  let currentImages = [];
  let deleteTargetId = null;
  let searchTerm = '';

  const esc = window.RshoesAdmin.escapeHtml;
  const modalBackdrop = document.getElementById('productModalBackdrop');
  const deleteBackdrop = document.getElementById('deleteModalBackdrop');

  function money(n) { return Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }

  function categoryTagLabel(slug) {
    const found = window.RSHOES_CATEGORY_TAGS.find((c) => c.slug === slug);
    return found ? found.label : slug;
  }

  function renderCategoryTagCheckboxes(selected) {
    const container = document.getElementById('categoryTags');
    const sel = selected || [];
    container.innerHTML = window.RSHOES_CATEGORY_TAGS.map((c) => `
      <label>
        <input type="checkbox" value="${c.slug}" ${sel.includes(c.slug) ? 'checked' : ''}>
        ${esc(c.label)}
      </label>`).join('');
  }

  function getSelectedCategoryTags() {
    return Array.from(document.querySelectorAll('#categoryTags input:checked')).map((el) => el.value);
  }

  function renderImagePreview() {
    const row = document.getElementById('imagePreviewRow');
    row.innerHTML = currentImages.map((url, i) => `
      <div class="image-preview">
        <img src="${url}" alt="Imagem ${i + 1}">
        <button type="button" data-remove="${i}" aria-label="Remover imagem">&times;</button>
      </div>`).join('');
    row.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentImages.splice(Number(btn.dataset.remove), 1);
        renderImagePreview();
      });
    });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleFiles(fileList) {
    for (const file of Array.from(fileList)) {
      try {
        const dataUrl = await fileToDataUrl(file);
        const result = await window.RshoesApi.post('/admin/uploads', { image: dataUrl });
        currentImages.push(result.url);
        renderImagePreview();
      } catch (err) {
        window.RshoesAdmin.toast(`Falha ao enviar "${file.name}": ${err.message}`, true);
      }
    }
  }

  function openModal(product) {
    document.getElementById('productModalTitle').textContent = product ? 'Editar produto' : 'Novo produto';
    document.getElementById('p-id').value = product ? product.id : '';
    document.getElementById('p-name').value = product ? product.name : '';
    document.getElementById('p-description').value = product ? (product.description || '') : '';
    renderCategoryTagCheckboxes(product ? product.category_tags : []);
    document.getElementById('p-brand').value = product ? product.brand || '' : '';
    document.getElementById('p-price').value = product ? product.price : '';
    document.getElementById('p-promo').value = product && product.promo_price != null ? product.promo_price : '';
    document.getElementById('p-stock').value = product ? product.stock : 0;
    document.getElementById('p-sku').value = product ? product.sku || '' : '';
    document.getElementById('p-sizes').value = product ? (product.sizes || []).join(', ') : '';
    document.getElementById('p-colors').value = product ? (product.colors || []).join(', ') : '';
    document.getElementById('p-tags').value = product ? (product.tags || []).join(', ') : '';
    document.getElementById('p-featured').checked = product ? !!product.featured : false;
    document.getElementById('p-active').checked = product ? !!product.active : true;
    currentImages = product ? [...(product.images || [])] : [];
    renderImagePreview();
    modalBackdrop.classList.add('open');
  }
  function closeModal() { modalBackdrop.classList.remove('open'); }

  function splitList(str) {
    return String(str || '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  function filteredProducts() {
    if (!searchTerm) return products;
    const t = searchTerm.toLowerCase();
    return products.filter((p) => p.name.toLowerCase().includes(t) || (p.brand || '').toLowerCase().includes(t) || (p.sku || '').toLowerCase().includes(t));
  }

  function renderRows() {
    const body = document.getElementById('productsBody');
    const list = filteredProducts();
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="7">Nenhum produto encontrado.</td></tr>';
      return;
    }
    body.innerHTML = list.map((p) => {
      const catLabel = (p.category_tags || []).map(categoryTagLabel).join(', ');
      const img = p.images && p.images[0] ? p.images[0] : '../assets/product-tenis.jpg';
      return `
        <tr class="prod-row">
          <td class="cell-thumb"><img class="thumb" src="${esc(img)}" alt=""></td>
          <td class="cell-name">${esc(p.name)}${p.featured ? ' ⭐' : ''}</td>
          <td>${catLabel ? esc(catLabel) : '—'}</td>
          <td>${money(p.promo_price != null ? p.promo_price : p.price)}${p.promo_price != null ? ` <span style="color:var(--grey); text-decoration:line-through; font-size:0.78rem;">${money(p.price)}</span>` : ''}</td>
          <td>
            <input type="number" inputmode="numeric" min="0" value="${p.stock}" data-stock="${p.id}" class="stock-input" aria-label="Estoque de ${esc(p.name)}">
          </td>
          <td><span class="pill ${p.active ? 'pill-on' : 'pill-off'}">${p.active ? 'Ativo' : 'Inativo'}</span></td>
          <td class="row-actions">
            <button class="icon-btn" data-edit="${p.id}" title="Editar">✎</button>
            <button class="icon-btn" data-toggle="${p.id}" title="${p.active ? 'Desativar' : 'Ativar'}">${p.active ? '🚫' : '✅'}</button>
            <button class="icon-btn danger" data-delete="${p.id}" title="Excluir">🗑</button>
          </td>
        </tr>`;
    }).join('');

    body.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => openModal(products.find((p) => p.id == btn.dataset.edit))));
    body.querySelectorAll('[data-delete]').forEach((btn) => btn.addEventListener('click', () => { deleteTargetId = btn.dataset.delete; deleteBackdrop.classList.add('open'); }));
    body.querySelectorAll('[data-toggle]').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        await window.RshoesApi.patch(`/admin/products/${btn.dataset.toggle}/toggle`);
        window.RshoesAdmin.toast('Status atualizado.');
        load();
      } catch (err) { window.RshoesAdmin.toast(err.message, true); }
    }));
    body.querySelectorAll('[data-stock]').forEach((input) => input.addEventListener('change', async () => {
      try {
        await window.RshoesApi.patch(`/admin/products/${input.dataset.stock}/stock`, { stock: Number(input.value) });
        window.RshoesAdmin.toast('Estoque atualizado.');
        load();
      } catch (err) { window.RshoesAdmin.toast(err.message, true); }
    }));
  }

  async function load() {
    try {
      const prodData = await window.RshoesApi.get('/admin/products');
      products = prodData.products;
      renderRows();
    } catch (err) {
      window.RshoesAdmin.toast(err.message, true);
    }
  }

  async function init() {
    const admin = await window.RshoesAdmin.guard();
    if (!admin) return;
    window.RshoesAdmin.bindLogout();

    document.getElementById('adminSearch').addEventListener('input', (e) => { searchTerm = e.target.value.trim(); renderRows(); });
    document.getElementById('newProductBtn').addEventListener('click', () => openModal(null));
    document.getElementById('productCancelBtn').addEventListener('click', closeModal);
    modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) closeModal(); });

    const imageDrop = document.getElementById('imageDrop');
    const imageInput = document.getElementById('imageInput');
    imageDrop.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', (e) => { handleFiles(e.target.files); imageInput.value = ''; });
    imageDrop.addEventListener('dragover', (e) => { e.preventDefault(); imageDrop.style.borderColor = 'var(--gold)'; });
    imageDrop.addEventListener('dragleave', () => { imageDrop.style.borderColor = ''; });
    imageDrop.addEventListener('drop', (e) => {
      e.preventDefault();
      imageDrop.style.borderColor = '';
      if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });

    document.getElementById('productForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('p-id').value;
      const payload = {
        name: document.getElementById('p-name').value.trim(),
        description: document.getElementById('p-description').value.trim(),
        category_tags: getSelectedCategoryTags(),
        brand: document.getElementById('p-brand').value.trim(),
        price: Number(document.getElementById('p-price').value),
        promo_price: document.getElementById('p-promo').value === '' ? null : Number(document.getElementById('p-promo').value),
        stock: Number(document.getElementById('p-stock').value) || 0,
        sku: document.getElementById('p-sku').value.trim() || null,
        sizes: splitList(document.getElementById('p-sizes').value),
        colors: splitList(document.getElementById('p-colors').value),
        tags: splitList(document.getElementById('p-tags').value),
        images: currentImages,
        featured: document.getElementById('p-featured').checked,
        active: document.getElementById('p-active').checked,
      };
      try {
        if (id) await window.RshoesApi.put(`/admin/products/${id}`, payload);
        else await window.RshoesApi.post('/admin/products', payload);
        closeModal();
        window.RshoesAdmin.toast('Produto salvo com sucesso.');
        load();
      } catch (err) {
        window.RshoesAdmin.toast(err.message, true);
      }
    });

    document.getElementById('deleteCancelBtn').addEventListener('click', () => { deleteBackdrop.classList.remove('open'); deleteTargetId = null; });
    document.getElementById('deleteConfirmBtn').addEventListener('click', async () => {
      if (!deleteTargetId) return;
      try {
        await window.RshoesApi.del(`/admin/products/${deleteTargetId}`);
        window.RshoesAdmin.toast('Produto excluído.');
      } catch (err) {
        window.RshoesAdmin.toast(err.message, true);
      } finally {
        deleteBackdrop.classList.remove('open');
        deleteTargetId = null;
        load();
      }
    });

    load();
  }

  init();
})();

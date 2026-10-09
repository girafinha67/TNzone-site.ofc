(function () {
  'use strict';

  let categories = [];
  let deleteTargetId = null;

  const modalBackdrop = document.getElementById('categoryModalBackdrop');
  const deleteBackdrop = document.getElementById('deleteModalBackdrop');
  const esc = window.RshoesAdmin.escapeHtml;

  function openModal(cat) {
    document.getElementById('categoryModalTitle').textContent = cat ? 'Editar categoria' : 'Nova categoria';
    document.getElementById('cat-id').value = cat ? cat.id : '';
    document.getElementById('cat-name').value = cat ? cat.name : '';
    document.getElementById('cat-image').value = cat && cat.image ? cat.image : '';
    document.getElementById('cat-description').value = cat && cat.description ? cat.description : '';
    document.getElementById('cat-order').value = cat ? cat.order_index : 0;
    document.getElementById('cat-active').checked = cat ? cat.active : true;
    modalBackdrop.classList.add('open');
  }
  function closeModal() { modalBackdrop.classList.remove('open'); }

  function renderRows() {
    const body = document.getElementById('categoriesBody');
    if (!categories.length) {
      body.innerHTML = '<tr><td colspan="5">Nenhuma categoria cadastrada ainda.</td></tr>';
      return;
    }
    body.innerHTML = categories.map((c) => `
      <tr>
        <td>${c.order_index}</td>
        <td>${esc(c.name)}</td>
        <td>${esc(c.slug)}</td>
        <td><span class="pill ${c.active ? 'pill-on' : 'pill-off'}">${c.active ? 'Ativa' : 'Inativa'}</span></td>
        <td class="row-actions">
          <button class="icon-btn" data-edit="${c.id}" title="Editar">✎</button>
          <button class="icon-btn danger" data-delete="${c.id}" title="Excluir">🗑</button>
        </td>
      </tr>`).join('');

    body.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => openModal(categories.find((c) => c.id == btn.dataset.edit)));
    });
    body.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', () => {
        deleteTargetId = btn.dataset.delete;
        deleteBackdrop.classList.add('open');
      });
    });
  }

  async function load() {
    try {
      const data = await window.RshoesApi.get('/categories');
      categories = data.categories;
      renderRows();
    } catch (err) {
      window.RshoesAdmin.toast(err.message, true);
    }
  }

  async function init() {
    const admin = await window.RshoesAdmin.guard();
    if (!admin) return;
    window.RshoesAdmin.bindLogout();

    document.getElementById('newCategoryBtn').addEventListener('click', () => openModal(null));
    document.getElementById('categoryCancelBtn').addEventListener('click', closeModal);
    modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) closeModal(); });

    document.getElementById('categoryForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('cat-id').value;
      const payload = {
        name: document.getElementById('cat-name').value.trim(),
        image: document.getElementById('cat-image').value.trim() || null,
        description: document.getElementById('cat-description').value.trim() || null,
        order_index: Number(document.getElementById('cat-order').value) || 0,
        active: document.getElementById('cat-active').checked,
      };
      try {
        if (id) await window.RshoesApi.put(`/admin/categories/${id}`, payload);
        else await window.RshoesApi.post('/admin/categories', payload);
        closeModal();
        window.RshoesAdmin.toast('Categoria salva com sucesso.');
        load();
      } catch (err) {
        window.RshoesAdmin.toast(err.message, true);
      }
    });

    document.getElementById('deleteCancelBtn').addEventListener('click', () => { deleteBackdrop.classList.remove('open'); deleteTargetId = null; });
    document.getElementById('deleteConfirmBtn').addEventListener('click', async () => {
      if (!deleteTargetId) return;
      try {
        await window.RshoesApi.del(`/admin/categories/${deleteTargetId}`);
        window.RshoesAdmin.toast('Categoria excluída.');
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

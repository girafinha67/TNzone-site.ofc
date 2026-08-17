// api.js — utilitário central de acesso à API. Carregado em todas as páginas.
const API = {
  async request(method, url, body) {
    const opts = {
      method,
      headers: {},
      credentials: 'include',
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { /* corpo vazio */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Erro ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get(url) { return this.request('GET', url); },
  post(url, body) { return this.request('POST', url, body); },
  put(url, body) { return this.request('PUT', url, body); },
  patch(url, body) { return this.request('PATCH', url, body); },
  del(url) { return this.request('DELETE', url); },
};

function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function money(value) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Categorias padrão (mesmas criadas pelo seed do banco em db.js). Usadas como
// fallback sempre que a API de categorias falhar ou ainda não tiver dados —
// assim os botões de categoria nunca ficam em branco/quebrados.
const DEFAULT_CATEGORIES = [
  { name: 'Tênis', slug: 'tenis' },
  { name: 'Camisas', slug: 'camisas' },
  { name: 'Calças', slug: 'calcas' },
  { name: 'Novidades', slug: 'novidades' },
];

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- WhatsApp ----------
function buildWhatsappMessage(product) {
  const hour = new Date().getHours();
  const saudacao = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';

  const typeLabel = {
    tenis: 'este modelo de tênis',
    camisa: 'esta camisa',
    calca: 'esta calça',
    outro: 'este produto',
  }[product.type] || 'este produto';

  return `${saudacao}! Fiquei interessado ${typeLabel} ${product.name}. Poderia me informar como posso prosseguir com a compra?`;
}

function whatsappUrl(number, message) {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

async function openWhatsappForProduct(product) {
  let number = '5561986553995';
  try {
    const { settings } = await API.get('/api/settings');
    if (settings.whatsapp_number) number = settings.whatsapp_number;
  } catch { /* usa número padrão */ }
  const msg = buildWhatsappMessage(product);
  window.open(whatsappUrl(number, msg), '_blank', 'noopener');
}

// ---------- Realtime ----------
// Em ambiente serverless (Netlify Functions) não há conexão persistente
// disponível para Server-Sent Events, então aqui simulamos "tempo real"
// com polling leve: a cada intervalo, avisamos quem escuta para refazer
// o fetch dos dados. Mesma assinatura de antes (onChange callback).
// Pausa automaticamente quando a aba fica oculta (evita requisições
// desnecessárias em segundo plano) e garante que nunca haja mais de um
// interval rodando por chamada de subscribeRealtime.
function subscribeRealtime(onChange, intervalMs = 15000) {
  let id = null;

  function start() {
    if (id !== null) return;
    id = setInterval(() => {
      try { onChange({}); } catch { /* ignora erros do callback */ }
    }, intervalMs);
  }
  function stop() {
    if (id === null) return;
    clearInterval(id);
    id = null;
  }

  function handleVisibility() {
    if (document.hidden) stop();
    else start();
  }

  if (!document.hidden) start();
  document.addEventListener('visibilitychange', handleVisibility);

  return {
    close: () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    },
  };
}

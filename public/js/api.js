// Wrapper fino sobre fetch: sempre manda/recebe cookies (sessão em HttpOnly
// cookie) e já trata JSON + erros no formato { error: "..." } vindo da API.
window.RshoesApi = (function () {
  'use strict';

  async function request(method, path, body) {
    const opts = {
      method,
      credentials: 'same-origin',
      headers: {},
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`/api${path}`, opts);
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Erro ${res.status}`);
      err.status = res.status;
      err.errors = data && data.errors;
      throw err;
    }
    return data;
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body || {}),
    put: (path, body) => request('PUT', path, body || {}),
    patch: (path, body) => request('PATCH', path, body || {}),
    del: (path) => request('DELETE', path),
  };
})();

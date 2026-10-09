'use strict';

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function slugify(text) {
  return (
    String(text)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)+/g, '')
      .slice(0, 80) || `item-${Date.now()}`
  );
}

// Escapa os curingas do SQL LIKE/ILIKE (%, _ e o próprio \) antes de montar
// um padrão "%texto%" com entrada livre do usuário — sem isso, buscar por
// "50%" ou "combo_promo" trata % e _ como curinga em vez de caractere
// literal, e a busca no catálogo devolve resultados errados.
function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (c) => `\\${c}`);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.ip || (req.socket && req.socket.remoteAddress) || '';
}

// Envolve handlers async para propagar erros ao Express (next(err))
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Valida um :id de rota como inteiro positivo, evitando repassar NaN ao Postgres.
function parseIntId(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = { parseCookies, slugify, escapeLike, clientIp, asyncHandler, parseIntId };

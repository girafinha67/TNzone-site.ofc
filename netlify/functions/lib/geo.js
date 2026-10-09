'use strict';

// Geolocalização aproximada (país/estado/cidade) a partir do IP — só para o
// mapa/lista de localização do Analytics. Por padrão FICA DESLIGADO (nenhuma
// chamada de rede, nenhum dado de localização é salvo) — é o modo mais
// privado e não depende de nenhum serviço externo/pago.
//
// Para habilitar, defina no Netlify:
//   IPGEO_PROVIDER=ipapi
//   IPGEO_API_KEY=xxxx        (opcional — só necessário acima do tier grátis)
//
// O provedor "ipapi" usa https://ipapi.co (tier gratuito ~1000 req/dia, sem
// necessidade de chave para volume baixo). Documentado em detalhe no
// README.md, seção "Analytics".
//
// IMPORTANTE: esta função NUNCA retorna/usa latitude/longitude (não
// armazenamos coordenadas exatas, só país/estado/cidade) e o IP em si nunca
// é persistido no banco — só passa pela memória durante esta chamada.

const PROVIDER = (process.env.IPGEO_PROVIDER || 'none').toLowerCase();
const TIMEOUT_MS = 1500;

function isPrivateOrInvalidIp(ip) {
  if (!ip) return true;
  return (
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
    ip === 'unknown'
  );
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function lookupIpapi(ip) {
  const key = process.env.IPGEO_API_KEY;
  const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/${key ? `?key=${encodeURIComponent(key)}` : ''}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || data.error) return null;
  return {
    country: data.country_name || null,
    region: data.region || null,
    city: data.city || null,
  };
}

// Retorna { country, region, city } ou null (nunca lança — best-effort).
async function lookupGeo(ip) {
  if (PROVIDER === 'none') return null;
  if (isPrivateOrInvalidIp(ip)) return null;

  try {
    if (PROVIDER === 'ipapi') return await lookupIpapi(ip);
    console.warn(`[rshoes] IPGEO_PROVIDER="${PROVIDER}" não é suportado — use "ipapi" ou remova a variável.`);
    return null;
  } catch (err) {
    // Timeout, provedor fora do ar, cota estourada etc. — nunca deve
    // derrubar o tracking por causa disso.
    console.warn('[rshoes] Falha ao consultar geolocalização por IP (não crítico):', err.message);
    return null;
  }
}

module.exports = { lookupGeo };

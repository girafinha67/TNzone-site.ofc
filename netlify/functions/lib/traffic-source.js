'use strict';

// Classifica a origem de uma visita a partir do referrer + parâmetros UTM.
// UTM sempre tem prioridade (é uma declaração explícita de campanha); na
// ausência dele, tenta reconhecer o domínio do referrer; sem nenhum dos
// dois, é acesso direto (digitou a URL, favoritos, app nativo etc).

const KNOWN_DOMAINS = [
  { match: /(^|\.)google\./i, source: 'Google', medium: 'organic' },
  { match: /(^|\.)bing\./i, source: 'Bing', medium: 'organic' },
  { match: /(^|\.)duckduckgo\./i, source: 'DuckDuckGo', medium: 'organic' },
  { match: /(^|\.)instagram\.com/i, source: 'Instagram', medium: 'social' },
  { match: /(^|\.)facebook\.com|(^|\.)fb\.com/i, source: 'Facebook', medium: 'social' },
  { match: /(^|\.)l\.facebook\.com/i, source: 'Facebook', medium: 'social' },
  { match: /(^|\.)tiktok\.com/i, source: 'TikTok', medium: 'social' },
  { match: /(^|\.)youtube\.com|(^|\.)youtu\.be/i, source: 'YouTube', medium: 'social' },
  { match: /(^|\.)whatsapp\.com|(^|\.)wa\.me/i, source: 'WhatsApp', medium: 'social' },
  { match: /(^|\.)twitter\.com|(^|\.)x\.com|(^|\.)t\.co/i, source: 'X (Twitter)', medium: 'social' },
  { match: /(^|\.)pinterest\./i, source: 'Pinterest', medium: 'social' },
  { match: /(^|\.)linkedin\.com/i, source: 'LinkedIn', medium: 'social' },
];

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

// Resolve a própria store (não deve contar como "referrer externo" quando a
// navegação é entre páginas do site — nesse caso é sessão contínua, não uma
// nova origem).
function isOwnDomain(url, selfHost) {
  const host = hostnameOf(url);
  return !!host && !!selfHost && host === selfHost;
}

function classifySource({ referrer, utmSource, utmMedium, utmCampaign, selfHost }) {
  if (utmSource) {
    return {
      source: String(utmSource).trim().slice(0, 100),
      medium: utmMedium ? String(utmMedium).trim().slice(0, 100) : 'campaign',
      isDirect: false,
    };
  }

  if (!referrer || isOwnDomain(referrer, selfHost)) {
    return { source: 'Direto', medium: 'direct', isDirect: true };
  }

  const host = hostnameOf(referrer);
  const known = KNOWN_DOMAINS.find((d) => d.match.test(host));
  if (known) return { source: known.source, medium: known.medium, isDirect: false };

  return { source: host || 'Outro', medium: 'referral', isDirect: false };
}

module.exports = { classifySource, hostnameOf };

'use strict';

// Endpoint do webhook da PromissePay (Netlify Function dedicada).
// URL pública: https://tnzone-site-loja.netlify.app/.netlify/functions/promissepay-webhook
//
// É uma função separada do Express (api.js) de propósito: a assinatura HMAC é calculada
// sobre o corpo BRUTO, e o express.json() de api.js reserializaria o JSON antes da checagem.

const { processWebhook } = require('./lib/promissepay-webhook');

exports.handler = async (event) => {
  const json = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { ...json, Allow: 'POST' }, body: JSON.stringify({ error: 'Método não permitido.' }) };
  }

  // Corpo exatamente como chegou (decodifica base64 se a plataforma tiver codificado).
  const rawBody = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');

  const { getDefault } = require('./lib/payments');
  const deps = getDefault();
  const db = require('./lib/db');

  const result = await processWebhook(
    {
      payments: deps.payments,
      client: deps.client,
      store: deps.store,
      secret: process.env.PROMISSEPAY_WEBHOOK_SECRET,
      ready: () => db.init(),
    },
    { rawBody, headers: event.headers || {} }
  );

  return { statusCode: result.statusCode, headers: json, body: JSON.stringify(result.body) };
};

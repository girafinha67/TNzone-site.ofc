'use strict';

const crypto = require('node:crypto');

const ENV = {
  production: 'https://ecommerce-api.svcp.picpay.com',
  sandbox: 'https://ecommerce-api.svcp.ppay.me',
};

let cachedToken = null;
let tokenExpiresAt = 0;
let tokenPromise = null;

function baseUrl() {
  const custom = process.env.PICPAY_API_BASE_URL;
  if (custom) return custom.replace(/\/+$/, '');
  return ENV[(process.env.PICPAY_ENV || 'production').toLowerCase()] || ENV.production;
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Variável ${name} não configurada.`);
  return v;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 30_000) return cachedToken;
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    const response = await fetch(`${baseUrl()}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: required('PICPAY_CLIENT_ID'),
        client_secret: required('PICPAY_CLIENT_SECRET'),
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      throw new Error(`Falha na autenticação PicPay (${response.status}): ${data.message || 'token não recebido'}`);
    }

    cachedToken = data.access_token;
    const expires = Number(data.expires_in) || 300;
    tokenExpiresAt = Date.now() + expires * 1000;
    return cachedToken;
  })();

  try {
    return await tokenPromise;
  } finally {
    tokenPromise = null;
  }
}

async function getCharge(merchantChargeId) {
  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (process.env.PICPAY_CALLER_ORIGIN) headers['caller-origin'] = process.env.PICPAY_CALLER_ORIGIN;

  const response = await fetch(`${baseUrl()}/charge/${encodeURIComponent(merchantChargeId)}`, {
    method: 'GET',
    headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.message || data.businessCode || 'erro desconhecido';
    const err = new Error(`Falha ao consultar cobrança PicPay (${response.status}): ${detail}`);
    err.status = response.status;
    err.picpay = data;
    throw err;
  }
  return data;
}

async function createPixCharge({ merchantChargeId, customer, amountCents, ip, sessionId }) {
  const token = await getAccessToken();

  const phoneDigits = String(customer.phone || '').replace(/\D/g, '');
  const countryCode = (process.env.PICPAY_COUNTRY_CODE || '55').replace(/\D/g, '');
  const areaCode = phoneDigits.slice(0, 2);
  const number = phoneDigits.slice(2);

  const payload = {
    paymentSource: 'GATEWAY',
    merchantChargeId,
    customer: {
      name: customer.name,
      email: customer.email,
      documentType: 'CPF',
      document: customer.cpf,
      phone: {
        countryCode,
        areaCode,
        number,
        type: 'MOBILE',
      },
    },
    transactions: [{
      amount: amountCents,
      pix: { expiration: Number(process.env.PICPAY_PIX_EXPIRATION_SECONDS) || 900 },
    }],
    deviceInformation: {
      ip: ip || '0.0.0.0',
      id: null,
      ipCountryCode: 'BRA',
      ipCity: null,
      ipRegion: null,
      sessionId: sessionId || null,
    },
  };

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (process.env.PICPAY_CALLER_ORIGIN) headers['caller-origin'] = process.env.PICPAY_CALLER_ORIGIN;

  const response = await fetch(`${baseUrl()}/charge/pix`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.message || data.businessCode || (Array.isArray(data.errors) && data.errors[0]?.message) || 'erro desconhecido';
    const err = new Error(`PicPay recusou a cobrança (${response.status}): ${detail}`);
    err.status = response.status;
    err.picpay = data;
    throw err;
  }

  return data;
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function verifyWebhookToken(headers) {
  const expected = process.env.PICPAY_WEBHOOK_TOKEN;
  if (!expected) throw new Error('PICPAY_WEBHOOK_TOKEN não configurado.');
  return safeEqual(headers.authorization || headers.Authorization, expected);
}

module.exports = { createPixCharge, getCharge, verifyWebhookToken };

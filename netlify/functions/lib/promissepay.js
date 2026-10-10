'use strict';

// Cliente da API PromissePay — https://promisse.com.br/docs
//
// Tudo aqui segue a documentação oficial (consultada em 10/10/2026):
//  - Base URL:      https://api.promisse.com.br
//  - Autenticação:  header `Authorization: sk_live_...` (chave CRUA, sem "Bearer")
//  - Criar PIX:     POST /transactions  { amount }            (centavos, mínimo 50)
//  - Consultar:     GET  /transactions/:id
//  - Webhook:       header `promisse-signature` = "sha256=" + HMAC-SHA256(corpo BRUTO, secret)
//
// A API NÃO documenta chave de idempotência nem campo de referência do pedido.
// Por isso: (1) nunca repetimos o POST automaticamente e (2) o vínculo
// pedido <-> cobrança é o `id` devolvido pela PromissePay, gravado em orders.promisse_id.

const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://api.promisse.com.br';
const DEFAULT_TIMEOUT_MS = 8000;
const MIN_AMOUNT_CENTS = 50;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

class GatewayError extends Error {
  constructor(message, { code, httpStatus, details } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.gatewayCode = code || 'GATEWAY_ERROR';
    this.httpStatus = httpStatus || null;
    // `details` nunca contém a chave de API; só dados devolvidos pelo gateway.
    this.details = details || null;
  }
}

function normalizeStatus(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

function readConfig(env) {
  const apiKey = String(env.PROMISSEPAY_API_KEY || '').trim();
  if (!apiKey) throw new GatewayError('PROMISSEPAY_API_KEY não configurada.', { code: 'NOT_CONFIGURED' });
  const baseUrl = String(env.PROMISSEPAY_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(baseUrl)) {
    throw new GatewayError('PROMISSEPAY_BASE_URL precisa ser HTTPS.', { code: 'NOT_CONFIGURED' });
  }
  const timeoutMs = Number(env.PROMISSEPAY_TIMEOUT_MS) > 0 ? Number(env.PROMISSEPAY_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  return { apiKey, baseUrl, timeoutMs };
}

function createClient({ env = process.env, fetchImpl } = {}) {
  async function request(method, path, body) {
    const cfg = readConfig(env);
    const doFetch = fetchImpl || globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

    let status;
    let text;
    try {
      const response = await doFetch(`${cfg.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: cfg.apiKey, // chave crua, conforme a documentação
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new GatewayError('A PromissePay não respondeu a tempo.', { code: 'GATEWAY_TIMEOUT' });
      }
      throw new GatewayError('Falha de rede ao falar com a PromissePay.', { code: 'NETWORK_ERROR' });
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }

    if (status < 200 || status >= 300) {
      const code = (data && typeof data.code === 'string' && data.code) || `HTTP_${status}`;
      const message = (data && typeof data.message === 'string' && data.message) || 'sem detalhe';
      throw new GatewayError(`PromissePay respondeu ${status} (${code}): ${message}`, {
        code,
        httpStatus: status,
        details: data && typeof data === 'object' ? { code, message } : null,
      });
    }
    if (!data || typeof data !== 'object') {
      throw new GatewayError('Resposta da PromissePay não é um JSON válido.', { code: 'INVALID_GATEWAY_RESPONSE', httpStatus: status });
    }
    return { status, data };
  }

  function toDataUrl(qr) {
    if (typeof qr !== 'string' || !qr.trim()) return null;
    const v = qr.trim();
    if (/^data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+$/i.test(v)) return v;
    if (/^[A-Za-z0-9+/=]+$/.test(v)) return `data:image/png;base64,${v}`;
    return null;
  }

  // Cria uma cobrança PIX REAL. Nunca é repetida automaticamente (sem idempotência no gateway).
  async function createPixCharge({ amountCents }) {
    if (!Number.isInteger(amountCents) || amountCents < MIN_AMOUNT_CENTS) {
      throw new GatewayError(`Valor mínimo da cobrança é ${MIN_AMOUNT_CENTS} centavos.`, { code: 'AMOUNT_INVALID' });
    }
    // O corpo só leva `amount`. Não enviamos `webhook`: a URL fica cadastrada no painel,
    // onde a secret do webhook é gerada e exibida.
    const { data } = await request('POST', '/transactions', { amount: amountCents });

    const id = typeof data.id === 'string' ? data.id.trim() : '';
    const copyPaste = typeof data.copyPaste === 'string' ? data.copyPaste.trim() : '';
    const qrCodeBase64 = toDataUrl(data.qrCodeBase64);
    const status = normalizeStatus(data.status);

    if (!ID_PATTERN.test(id) || !copyPaste || !qrCodeBase64 || status !== 'PENDING' || data.amount !== amountCents) {
      // Nunca monta QR/copia-e-cola a partir de resposta incompleta ou divergente.
      throw new GatewayError('Resposta inválida da PromissePay ao criar a cobrança.', {
        code: 'INVALID_GATEWAY_RESPONSE',
        details: { hasId: Boolean(id), hasCopyPaste: Boolean(copyPaste), hasQr: Boolean(qrCodeBase64), status, amountMatches: data.amount === amountCents },
      });
    }

    let expiresAt = null;
    if (data.expiresAt) {
      const d = new Date(data.expiresAt);
      if (!Number.isNaN(d.getTime())) expiresAt = d.toISOString();
    }

    return {
      id,
      status: 'PENDING',
      amountCents,
      copyPaste,
      qrCodeBase64,
      expiresAt,
      fee: Number.isInteger(data.fee) ? data.fee : null,
    };
  }

  // Estado real da cobrança (fonte de verdade para confirmar pagamento).
  async function getTransaction(id) {
    const txId = String(id || '').trim();
    if (!ID_PATTERN.test(txId)) {
      throw new GatewayError('ID de transação inválido.', { code: 'INVALID_TRANSACTION_ID' });
    }
    const { data } = await request('GET', `/transactions/${encodeURIComponent(txId)}`);

    // Garante que a resposta é mesmo da transação pedida (evita um pedido alterar outro).
    if (data.id !== txId || typeof data.status !== 'string' || !Number.isInteger(data.amount)) {
      throw new GatewayError('Resposta inválida da PromissePay ao consultar a cobrança.', { code: 'INVALID_GATEWAY_RESPONSE' });
    }
    return {
      id: data.id,
      status: normalizeStatus(data.status),
      type: data.type ? normalizeStatus(data.type) : null,
      amount: data.amount,
      fee: Number.isInteger(data.fee) ? data.fee : null,
    };
  }

  return { createPixCharge, getTransaction };
}

// Assinatura do webhook, exatamente como na documentação:
// "sha256=" + HMAC-SHA256(corpo BRUTO, secret) em hexadecimal, comparado em tempo constante.
function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret || typeof signatureHeader !== 'string' || !Buffer.isBuffer(rawBody)) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const received = Buffer.from(signatureHeader.trim());
  const wanted = Buffer.from(expected);
  return received.length === wanted.length && crypto.timingSafeEqual(received, wanted);
}

module.exports = {
  GatewayError,
  createClient,
  verifyWebhookSignature,
  normalizeStatus,
  MIN_AMOUNT_CENTS,
  ID_PATTERN,
};

'use strict';

// Processamento do webhook da PromissePay (sem dependência de Netlify/Express,
// para poder ser testado). A Netlify Function promissepay-webhook.js só adapta
// o evento HTTP e chama processWebhook().
//
// Contrato (documentação oficial):
//  - POST JSON { event, timestamp, data }, assinado em `promisse-signature`
//    = "sha256=" + HMAC-SHA256(corpo BRUTO, secret)
//  - Eventos usados: payment.approved, payment.failed. Os demais (transfer-*, pix.infraction)
//    não se aplicam a pedidos da loja e são ignorados com 200.
//  - Ao cadastrar o webhook a PromissePay envia {"event":"webhook.test"} e exige 200/201/202.
//  - O mesmo evento pode chegar mais de uma vez: a chave de idempotência é event + data.id.
//  - Timeout de entrega: 10 s.

const { verifyWebhookSignature, normalizeStatus, ID_PATTERN } = require('./promissepay');
const { PaymentError } = require('./payments');

function headerValue(headers, name) {
  if (!headers) return '';
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return String(headers[key] ?? '');
  }
  return '';
}

function respond(statusCode, body) {
  return { statusCode, body };
}

async function processWebhook({ payments, client, store, secret, ready, log = console }, { rawBody, headers }) {
  let payload = null;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { payload = null; }

  // Teste de cadastro: não carrega dados nem altera nada, então responde 200 sem exigir assinatura
  // (a documentação não afirma que o teste venha assinado).
  if (payload && payload.event === 'webhook.test') return respond(200, { ok: true });

  if (!secret) {
    log.error('[promissepay-webhook] PROMISSEPAY_WEBHOOK_SECRET não configurada; evento recusado.');
    return respond(500, { error: 'Webhook não configurado.' });
  }
  if (!verifyWebhookSignature(rawBody, headerValue(headers, 'promisse-signature'), secret)) {
    log.warn('[promissepay-webhook] assinatura inválida');
    return respond(401, { error: 'Assinatura inválida.' });
  }

  if (!payload || typeof payload !== 'object' || typeof payload.event !== 'string') {
    return respond(400, { error: 'Corpo inválido.' });
  }
  const event = payload.event;
  if (event !== 'payment.approved' && event !== 'payment.failed') {
    return respond(200, { received: true, ignored: true });
  }

  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const promisseId = typeof data.id === 'string' ? data.id.trim() : '';
  if (!ID_PATTERN.test(promisseId)) return respond(400, { error: 'ID da transação ausente ou inválido.' });

  const eventKey = `promisse:${event}:${promisseId}`;

  try {
    if (ready) await ready();

    // O pedido é sempre localizado pelo id da transação (único): um evento nunca atinge outro pedido.
    const order = await store.findOrderByPromisseId(promisseId);
    if (!order) {
      log.warn('[promissepay-webhook] transação sem pedido correspondente', { promisseId });
      return respond(404, { error: 'Transação desconhecida.' });
    }

    let result;
    if (event === 'payment.approved') {
      // A assinatura prova a origem; ainda assim o estado real é confirmado na API
      // antes de marcar como pago (e o valor é conferido contra o pedido).
      const confirmed = await client.getTransaction(promisseId);
      if (normalizeStatus(confirmed.status) !== 'PAID') {
        log.warn('[promissepay-webhook] approved recebido, mas a API ainda não confirma', { promisseId, status: confirmed.status });
        return respond(503, { error: 'Pagamento ainda não confirmado na API.' });
      }
      result = await payments.applyPaid({ transaction: confirmed, eventKey, eventType: event, payload });
    } else {
      result = await payments.applyFailed({ promisseId, eventKey, eventType: event, payload });
    }

    return respond(200, { received: true, duplicate: Boolean(result.duplicate), status: result.order && result.order.status });
  } catch (err) {
    if (err instanceof PaymentError) {
      log.error('[promissepay-webhook] evento rejeitado', { promisseId, code: err.code });
      return respond(err.status, { error: err.message });
    }
    if (err && err.name === 'GatewayError') {
      log.error('[promissepay-webhook] falha ao consultar a API', { promisseId, code: err.gatewayCode });
      return respond(502, { error: 'Falha ao confirmar o pagamento na API.' });
    }
    log.error('[promissepay-webhook] erro interno', { promisseId, message: err && err.message });
    return respond(500, { error: 'Erro interno.' });
  }
}

module.exports = { processWebhook };

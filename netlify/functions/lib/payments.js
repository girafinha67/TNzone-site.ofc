'use strict';

// Regras de pagamento PIX (PromissePay). Banco e cliente HTTP são injetados:
// em produção vêm de getDefault(); nos testes automatizados, de fakes.

const { normalizeStatus, MIN_AMOUNT_CENTS } = require('./promissepay');

class PaymentError extends Error {
  constructor(message, status = 500, code = 'PAYMENT_ERROR') {
    super(message);
    this.name = 'PaymentError';
    this.status = status;
    this.code = code;
  }
}

function orderCents(order) {
  return Math.round(Number(order.amount) * 100);
}

// Converte falha do gateway numa mensagem segura para o cliente (sem detalhes internos).
function toPublicError(err) {
  const code = err && err.gatewayCode;
  if (code === 'AMOUNT_INVALID') return new PaymentError('Valor do pedido abaixo do mínimo para PIX.', 400, code);
  if (code === 'TOO_MANY_REQUESTS') return new PaymentError('Muitos pagamentos sendo gerados agora. Aguarde alguns segundos e tente de novo.', 429, code);
  if (code === 'GATEWAY_TIMEOUT') return new PaymentError('O provedor de pagamento demorou para responder. Tente novamente.', 504, code);
  return new PaymentError('Não deu pra gerar o pagamento agora. Tente novamente em instantes.', 502, code || 'GATEWAY_ERROR');
}

function createPayments({
  store,
  client,
  notifyPaid = async () => {},
  now = () => Date.now(),
  log = console,
  refreshMinSeconds = 10,
  expiryGraceMs = 2 * 60 * 1000,
  orphanAfterMs = 15 * 60 * 1000,
  fallbackExpiryMs = 24 * 60 * 60 * 1000,
} = {}) {
  // Cria a cobrança real para um pedido já gravado como PENDING (estoque reservado).
  // Em qualquer falha: pedido vira ERROR e o estoque é devolvido. Sem retry automático.
  async function startPixCharge(order) {
    const amountCents = orderCents(order);
    let charge;
    try {
      charge = await client.createPixCharge({ amountCents });
    } catch (err) {
      log.error('[promissepay] falha ao criar cobrança', { orderId: order.id, code: err.gatewayCode || err.code, http: err.httpStatus || null });
      await store.failOrderAndRelease(order.id, `Falha ao criar cobrança (${err.gatewayCode || 'erro'})`);
      throw toPublicError(err);
    }

    try {
      const linked = await store.saveCharge(order.id, charge);
      if (!linked) throw new Error('pedido já possuía cobrança vinculada');
    } catch (err) {
      // A cobrança existe no gateway, mas não foi vinculada. O cliente nunca recebe o QR
      // e o pedido órfão é encerrado pela reconciliação. O id fica no log p/ conferência.
      log.error('[promissepay] cobrança criada mas não vinculada ao pedido', { orderId: order.id, promisseId: charge.id });
      throw new PaymentError('Não deu pra gerar o pagamento. Tente novamente.', 500, 'PERSIST_FAILED');
    }
    return store.findOrderById(order.id);
  }

  // Aplica uma transação CONFIRMADA PELO GATEWAY (GET /transactions/:id) como paga.
  async function applyPaid({ transaction, eventKey = null, eventType = 'RECONCILIATION', payload = null }) {
    const promisseId = String(transaction && transaction.id || '');
    if (!promisseId) throw new PaymentError('ID da transação ausente.', 400, 'MISSING_ID');
    if (normalizeStatus(transaction.status) !== 'PAID') {
      throw new PaymentError('Transação não está paga.', 409, 'NOT_PAID');
    }

    const outcome = await store.tx(async (t) => {
      const order = await t.lockOrderByPromisseId(promisseId);
      if (!order) throw new PaymentError('Pedido não encontrado para esta transação.', 404, 'ORDER_NOT_FOUND');

      // Validações antes de gravar qualquer coisa (se lançar, a transação inteira é revertida,
      // inclusive o registro do evento — a notificação pode ser reenviada).
      if (transaction.type && normalizeStatus(transaction.type) !== 'DEPOSIT') {
        throw new PaymentError('Tipo de transação inesperado para um pagamento de pedido.', 409, 'TYPE_MISMATCH');
      }
      const expected = orderCents(order);
      if (!Number.isInteger(transaction.amount) || transaction.amount !== expected) {
        log.error('[promissepay] valor divergente', { orderId: order.id, expected, received: transaction.amount });
        throw new PaymentError(`Valor divergente: esperado ${expected} centavos, recebido ${transaction.amount}.`, 409, 'AMOUNT_MISMATCH');
      }

      if (eventKey) {
        const inserted = await t.recordEvent({ key: eventKey, merchantChargeId: order.merchant_charge_id, type: eventType, status: 'PAID', payload });
        if (!inserted) return { order, duplicate: true, paidNow: false };
      }
      if (order.status === 'PAID') return { order, duplicate: false, paidNow: false };

      let note = null;
      if (!Number(order.stock_reserved)) {
        // Pedido já tinha expirado/falhado e o estoque foi devolvido: tenta reservar de novo.
        const reserved = await t.reserveStock(order);
        if (!reserved) note = 'Pago após o pedido ter sido encerrado e sem estoque suficiente — revisar manualmente.';
      }
      await t.markPaid(order, { note });
      await t.enqueueNotification(order.id);
      return { order: await t.getOrder(order.id), duplicate: false, paidNow: true };
    });

    if (outcome.paidNow) {
      try { await notifyPaid(outcome.order.id); } catch (err) {
        log.error('[promissepay] notificação pós-pagamento falhou (pagamento segue confirmado)', { orderId: outcome.order.id });
      }
    }
    return outcome;
  }

  // payment.failed: cobrança recusada ou expirada sem pagamento (conforme a documentação).
  async function applyFailed({ promisseId, eventKey = null, eventType = 'payment.failed', payload = null }) {
    return store.tx(async (t) => {
      const order = await t.lockOrderByPromisseId(String(promisseId || ''));
      if (!order) throw new PaymentError('Pedido não encontrado para esta transação.', 404, 'ORDER_NOT_FOUND');
      if (eventKey) {
        const inserted = await t.recordEvent({ key: eventKey, merchantChargeId: order.merchant_charge_id, type: eventType, status: 'FAILED', payload });
        if (!inserted) return { order, duplicate: true };
      }
      // Um pedido já pago nunca volta atrás por causa de um evento de falha.
      if (order.status !== 'PENDING') return { order, duplicate: false };
      await t.closeOrder(order, 'FAILED');
      return { order: await t.getOrder(order.id), duplicate: false };
    });
  }

  // Reconsulta o estado real no gateway. Usado pelo status do pedido (com throttle),
  // pela reconciliação agendada e pelo botão do admin (force).
  async function refreshOrder(order, { force = false } = {}) {
    if (!order || order.status !== 'PENDING' || !order.promisse_id) return order;

    if (force) await store.touchChecked(order.id);
    else if (!(await store.claimRefresh(order.id, refreshMinSeconds))) return order;

    let tx;
    try {
      tx = await client.getTransaction(order.promisse_id);
    } catch (err) {
      log.error('[promissepay] consulta de cobrança falhou', { orderId: order.id, code: err.gatewayCode || err.code });
      if (force) throw err;
      return order;
    }

    if (tx.status === 'PAID') {
      try {
        const out = await applyPaid({ transaction: tx });
        return out.order;
      } catch (err) {
        log.error('[promissepay] não foi possível aplicar pagamento consultado', { orderId: order.id, code: err.code });
        if (force) throw err;
        return order;
      }
    }

    // Status que a documentação não descreve ficam apenas registrados; o pedido não muda por eles.
    await store.setPromisseStatus(order.id, tx.status);

    const createdMs = new Date(order.created_at).getTime();
    const expiresMs = order.pix_expires_at ? new Date(order.pix_expires_at).getTime() : createdMs + fallbackExpiryMs;
    if (Number.isFinite(expiresMs) && now() > expiresMs + expiryGraceMs) {
      await store.expireOrder(order.id);
    }
    return store.findOrderById(order.id);
  }

  // Executada a cada 10 min (reconcile-payments): rede de segurança caso um webhook se perca.
  async function reconcilePending({ limit = 20 } = {}) {
    const orphans = await store.expireOrphans(orphanAfterMs);
    const rows = await store.listReconcilable(limit);
    const summary = { checked: 0, paid: 0, expired: 0, failed: 0, orphans };
    for (const row of rows) {
      summary.checked += 1;
      try {
        const after = await refreshOrder(row, { force: true });
        if (after && after.status === 'PAID') summary.paid += 1;
        else if (after && after.status === 'EXPIRED') summary.expired += 1;
      } catch (err) {
        summary.failed += 1;
      }
    }
    return summary;
  }

  return { startPixCharge, applyPaid, applyFailed, refreshOrder, reconcilePending };
}

let defaultInstance = null;
function getDefault() {
  if (!defaultInstance) {
    const { createClient } = require('./promissepay');
    const store = require('./payments-store');
    const { deliverPendingWhatsApp } = require('./order-notifications');
    const client = createClient();
    defaultInstance = {
      payments: createPayments({ store, client, notifyPaid: deliverPendingWhatsApp }),
      store,
      client,
    };
  }
  return defaultInstance;
}

module.exports = { createPayments, PaymentError, toPublicError, getDefault, orderCents, MIN_AMOUNT_CENTS };

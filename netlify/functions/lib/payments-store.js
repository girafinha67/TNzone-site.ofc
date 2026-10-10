'use strict';

// Acesso ao Postgres para pagamentos. Usa a tabela `orders` existente
// (colunas novas: payment_provider, promisse_*, checkout_token — ver db.js e
// migrations/2026-10-10_promissepay.sql). O estoque é tratado aqui porque
// reservar/devolver precisa acontecer na mesma transação da mudança de status.

const db = require('./db');

async function orderItems(t, order) {
  if (order.is_cart) {
    return t.all('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [order.id]);
  }
  return order.product_id ? [{ product_id: order.product_id, quantity: order.quantity }] : [];
}

async function releaseStock(t, order) {
  if (!Number(order.stock_reserved)) return;
  for (const it of await orderItems(t, order)) {
    if (it.product_id) {
      await t.run('UPDATE products SET stock = stock + ?, updated_at = NOW() WHERE id = ?', [it.quantity, it.product_id]);
    }
  }
  await t.run('UPDATE orders SET stock_reserved = 0, updated_at = NOW() WHERE id = ?', [order.id]);
}

// Reserva de novo (pagamento chegou depois do pedido ser encerrado). Tudo-ou-nada.
async function reserveStock(t, order) {
  const items = (await orderItems(t, order)).filter((it) => it.product_id);
  for (const it of items) {
    const p = await t.get('SELECT stock FROM products WHERE id = ? FOR UPDATE', [it.product_id]);
    if (!p || Number(p.stock) < Number(it.quantity)) return false;
  }
  for (const it of items) {
    await t.run('UPDATE products SET stock = stock - ?, updated_at = NOW() WHERE id = ?', [it.quantity, it.product_id]);
  }
  return true;
}

function scoped(client) {
  return {
    get: client.get,
    all: client.all,
    run: client.run,

    lockOrderByPromisseId: (id) => client.get('SELECT * FROM orders WHERE promisse_id = ? FOR UPDATE', [id]),
    getOrder: (id) => client.get('SELECT * FROM orders WHERE id = ?', [id]),

    // Idempotência de notificações: event_id é UNIQUE; conflito => já processado.
    async recordEvent({ key, merchantChargeId, type, status, payload }) {
      const r = await client.run(
        `INSERT INTO payment_webhook_events
           (event_id, merchant_charge_id, event_type, status, payload, received_at, processed_at)
         VALUES (?, ?, ?, ?, ?::jsonb, NOW(), NOW())
         ON CONFLICT (event_id) DO NOTHING`,
        [key, merchantChargeId, type, status, JSON.stringify(payload || {})]
      );
      return r.changes > 0;
    },

    reserveStock: (order) => reserveStock(client, order),

    async markPaid(order, { note }) {
      await client.run(
        `UPDATE orders
            SET status='PAID', promisse_status='PAID', paid_at=COALESCE(paid_at, NOW()),
                transaction_id=COALESCE(transaction_id, promisse_id), stock_reserved=0,
                error_message=?, updated_at=NOW()
          WHERE id=?`,
        [note || null, order.id]
      );
    },

    async closeOrder(order, status) {
      await releaseStock(client, order);
      await client.run(
        `UPDATE orders SET status=?, promisse_status=COALESCE(promisse_status, ?), updated_at=NOW() WHERE id=?`,
        [status, status, order.id]
      );
    },

    async enqueueNotification(orderId) {
      await client.run(
        `INSERT INTO payment_notifications (order_id, type, status, attempts, created_at, updated_at)
         VALUES (?, 'WHATSAPP_PAYMENT_RECEIVED', 'PENDING', 0, NOW(), NOW())
         ON CONFLICT (order_id, type) DO NOTHING`,
        [orderId]
      );
    },
  };
}

module.exports = {
  findOrderById: (id) => db.get('SELECT * FROM orders WHERE id = ?', [id]),
  findOrderByPromisseId: (id) => db.get('SELECT * FROM orders WHERE promisse_id = ?', [id]),
  findOrderByToken: (token) => db.get('SELECT * FROM orders WHERE checkout_token = ?', [token]),

  tx: (fn) => db.tx(async (client) => fn(scoped(client))),

  // Vincula a cobrança ao pedido apenas uma vez (promisse_id IS NULL).
  async saveCharge(orderId, charge) {
    const r = await db.run(
      `UPDATE orders
          SET promisse_id=?, promisse_status='PENDING', promisse_fee=?, payment_provider='promissepay',
              status='PENDING', pix_qr_code=?, pix_qr_code_base64=?, pix_expires_at=?, updated_at=NOW()
        WHERE id=? AND promisse_id IS NULL`,
      [charge.id, charge.fee, charge.copyPaste, charge.qrCodeBase64, charge.expiresAt, orderId]
    );
    return r.changes > 0;
  },

  // Falha ao criar a cobrança: pedido vira ERROR e o estoque reservado volta.
  failOrderAndRelease(orderId, message) {
    return db.tx(async (client) => {
      const order = await client.get('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
      if (!order) return;
      await releaseStock(client, order);
      await client.run(`UPDATE orders SET status='ERROR', error_message=?, updated_at=NOW() WHERE id=?`, [message, orderId]);
    });
  },

  async expireOrder(orderId) {
    await db.tx(async (client) => {
      const order = await client.get('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
      if (!order || order.status !== 'PENDING') return;
      await scoped(client).closeOrder(order, 'EXPIRED');
    });
  },

  // Throttle atômico: só um chamador por janela consulta o gateway.
  async claimRefresh(orderId, minSeconds) {
    const r = await db.run(
      `UPDATE orders SET promisse_checked_at=NOW()
        WHERE id=? AND status='PENDING'
          AND (promisse_checked_at IS NULL OR promisse_checked_at < NOW() - make_interval(secs => ?::float8))`,
      [orderId, minSeconds]
    );
    return r.changes > 0;
  },
  touchChecked: (orderId) => db.run('UPDATE orders SET promisse_checked_at=NOW() WHERE id=?', [orderId]),

  // Só registra status bruto desconhecido; não altera o estado do pedido.
  setPromisseStatus: (orderId, status) =>
    db.run(`UPDATE orders SET promisse_status=?, updated_at=NOW() WHERE id=? AND status='PENDING'`, [status, orderId]),

  listReconcilable: (limit) =>
    db.all(
      `SELECT * FROM orders
        WHERE status='PENDING' AND payment_provider='promissepay' AND promisse_id IS NOT NULL
          AND created_at > NOW() - INTERVAL '2 days'
        ORDER BY COALESCE(promisse_checked_at, created_at) ASC
        LIMIT ?`,
      [limit]
    ),

  // Pedidos PENDING sem cobrança vinculada (falha no meio da criação): encerra e devolve estoque.
  async expireOrphans(olderThanMs) {
    const rows = await db.all(
      `SELECT id FROM orders
        WHERE status='PENDING' AND payment_provider='promissepay' AND promisse_id IS NULL
          AND created_at < NOW() - make_interval(secs => ?::float8)
        LIMIT 50`,
      [olderThanMs / 1000]
    );
    let n = 0;
    for (const { id } of rows) {
      await db.tx(async (client) => {
        const order = await client.get('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
        if (!order || order.status !== 'PENDING' || order.promisse_id) return;
        await releaseStock(client, order);
        await client.run(`UPDATE orders SET status='ERROR', error_message='Cobrança não foi vinculada ao pedido', updated_at=NOW() WHERE id=?`, [id]);
        n += 1;
      });
    }
    return n;
  },
};

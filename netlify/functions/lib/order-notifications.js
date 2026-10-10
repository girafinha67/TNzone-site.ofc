'use strict';

// Entrega da notificação de WhatsApp (outbox em payment_notifications).
// Movido de routes/orders.routes.js sem alterar o comportamento.

const db = require('./db');
const { notifyOwner, formatPaidOrder } = require('./whatsapp');

async function deliverPendingWhatsApp(orderId) {
  const pending = await db.get(
    `SELECT n.*, o.*
       FROM payment_notifications n
       JOIN orders o ON o.id = n.order_id
      WHERE n.order_id = ?
        AND n.type = 'WHATSAPP_PAYMENT_RECEIVED'
        AND n.status = 'PENDING'
      LIMIT 1`,
    [orderId]
  );
  if (!pending) return false;

  try {
    const items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [orderId]);
    const result = await notifyOwner(formatPaidOrder(pending, items));
    if (!result?.sent) throw new Error('WhatsApp não está configurado para receber notificações.');
    await db.run(
      `UPDATE payment_notifications
          SET status='SENT', sent_at=NOW(), updated_at=NOW(), last_error=NULL
        WHERE id=? AND status='PENDING'`,
      [pending.id]
    );
    await db.run(
      `UPDATE orders SET whatsapp_notified_at=COALESCE(whatsapp_notified_at, NOW()), updated_at=NOW() WHERE id=?`,
      [orderId]
    );
    return true;
  } catch (err) {
    await db.run(
      `UPDATE payment_notifications
          SET attempts=attempts+1, last_error=?, updated_at=NOW()
        WHERE id=? AND status='PENDING'`,
      [String(err.message || err).slice(0, 2000), pending.id]
    );
    console.error('[rshoes] WhatsApp notification failed:', err.message);
    return false;
  }
}

module.exports = { deliverPendingWhatsApp };

'use strict';

const express = require('express');
const crypto = require('node:crypto');
const db = require('../lib/db');
const { createPixCharge, getCharge, verifyWebhookToken } = require('../lib/picpay');
const { notifyOwner, formatPaidOrder } = require('../lib/whatsapp');

const router = express.Router();

function digits(v) { return String(v || '').replace(/\D/g, ''); }
function normalizeCpf(v) { return digits(v); }
function validCpf(cpf) {
  cpf = normalizeCpf(cpf);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1+$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(cpf[i]) * (10 - i);
  let d1 = (sum * 10) % 11; if (d1 === 10) d1 = 0;
  if (d1 !== Number(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cpf[i]) * (11 - i);
  let d2 = (sum * 10) % 11; if (d2 === 10) d2 = 0;
  return d2 === Number(cpf[10]);
}
function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim()); }
function validPhone(v) { return /^55\d{10,11}$/.test(digits(v)) || /^\d{10,11}$/.test(digits(v)); }
function publicOrder(row) {
  return {
    id: row.id,
    status: row.status,
    product: {
      id: row.product_id,
      name: row.product_name,
      slug: row.product_slug,
      image: row.product_image,
    },
    quantity: row.quantity,
    unit_price: Number(row.unit_price),
    amount: Number(row.amount),
    points: Number(row.points),
    size: row.size,
    color: row.color,
    additionalData: row.additional_data,
    pix: row.pix_qr_code ? {
      qrCode: row.pix_qr_code,
      qrCodeBase64: row.pix_qr_code_base64,
      expiresAt: row.pix_expires_at,
    } : null,
    payment: row.status === 'PAID' ? {
      received: true,
      paidAt: row.paid_at,
      transactionId: row.transaction_id,
    } : { received: false },
  };
}
function getIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return String(xff || req.socket?.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/, '') || '0.0.0.0';
}
function amountFromProduct(product) {
  return Number(product.promo_price != null ? product.promo_price : product.price);
}

router.post('/payments/picpay/create', async (req, res) => {
  try {
    const b = req.body || {};
    const productId = Number(b.productId);
    const quantity = Math.floor(Number(b.quantity || 1));
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const cpf = normalizeCpf(b.cpf);
    const phone = digits(b.phone);
    const size = b.size ? String(b.size).trim().slice(0, 80) : null;
    const color = b.color ? String(b.color).trim().slice(0, 80) : null;
    const additionalData = b.additionalData ? String(b.additionalData).trim().slice(0, 1000) : null;

    if (!Number.isInteger(productId) || productId <= 0) return res.status(400).json({ error: 'Produto inválido.' });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) return res.status(400).json({ error: 'Quantidade inválida.' });
    if (name.length < 3) return res.status(400).json({ error: 'Informe o nome completo.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
    if (!validCpf(cpf)) return res.status(400).json({ error: 'CPF inválido.' });
    if (!validPhone(phone)) return res.status(400).json({ error: 'Telefone inválido.' });

    const order = await db.tx(async ({ get, run }) => {
      const product = await get('SELECT * FROM products WHERE id = ? AND active = 1 FOR UPDATE', [productId]);
      if (!product) {
        const e = new Error('Produto não encontrado ou indisponível.');
        e.status = 404; throw e;
      }
      const unitPrice = amountFromProduct(product);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        const e = new Error('Produto sem preço válido.');
        e.status = 400; throw e;
      }
      if (Number(product.stock) < quantity) {
        const e = new Error(`Estoque insuficiente. Disponível: ${product.stock}.`);
        e.status = 409; throw e;
      }

      // Reserva o estoque enquanto a cobrança estiver pendente.
      await run('UPDATE products SET stock = stock - ?, updated_at = NOW() WHERE id = ?', [quantity, productId]);

      const id = crypto.randomUUID();
      const merchantChargeId = crypto.randomUUID();
      const amount = Math.round(unitPrice * quantity * 100) / 100;
      const pointsPerReal = Number(process.env.POINTS_PER_REAL || 1);
      const points = Math.floor(amount * pointsPerReal);

      await run(
        `INSERT INTO orders
          (id, merchant_charge_id, product_id, product_name, product_slug, product_image,
           quantity, unit_price, amount, points, customer_name, customer_cpf, customer_email,
           customer_phone, size, color, additional_data, status, created_at, updated_at, stock_reserved)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NOW(), NOW(), 1)`,
        [
          id, merchantChargeId, product.id, product.name, product.slug,
          JSON.parse(product.images || '[]')[0] || null, quantity, unitPrice, amount, points,
          name, cpf, email, phone, size, color, additionalData
        ]
      );

      return { id, merchantChargeId, amount, customer: { name, email, cpf, phone }, sessionId: b.sessionId || null };
    });

    let charge;
    try {
      charge = await createPixCharge({
        merchantChargeId: order.merchantChargeId,
        customer: order.customer,
        amountCents: Math.round(order.amount * 100),
        ip: getIp(req),
        sessionId: order.sessionId,
      });
    } catch (err) {
      // A cobrança não foi criada; devolve a reserva para não prender estoque.
      await db.tx(async ({ run }) => {
        await run('UPDATE products SET stock = stock + ?, updated_at = NOW() WHERE id = (SELECT product_id FROM orders WHERE id = ?)', [quantity, order.id]);
        await run(`UPDATE orders SET status = 'ERROR', error_message = ?, stock_reserved = 0, updated_at = NOW() WHERE id = ?`, [err.message, order.id]);
      });
      throw err;
    }

    const transaction = Array.isArray(charge.transactions) ? charge.transactions[0] : null;
    const pix = transaction?.pix || {};
    const expiresAt = new Date(Date.now() + ((Number(process.env.PICPAY_PIX_EXPIRATION_SECONDS) || 900) * 1000)).toISOString();

    await db.run(
      `UPDATE orders SET picpay_id = ?, status = ?, pix_qr_code = ?, pix_qr_code_base64 = ?,
       pix_expires_at = ?, updated_at = NOW() WHERE id = ?`,
      [
        charge.id || null,
        charge.chargeStatus || transaction?.transactionStatus || 'PENDING',
        pix.qrCode || null,
        pix.qrCodeBase64 || null,
        expiresAt,
        order.id,
      ]
    );

    const saved = await db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
    res.status(201).json(publicOrder(saved));
  } catch (err) {
    console.error('[rshoes] create payment:', err);
    res.status(err.status || 500).json({ error: err.message || 'Não deu pra gerar o pagamento.' });
  }
});

// POST /api/payments/picpay/create-cart — cobrança única para vários produtos
// (carrinho). Endpoint novo e independente do /payments/picpay/create acima:
// a compra direta de 1 produto (página de produto → "Comprar agora") continua
// usando o endpoint antigo, sem nenhuma alteração de comportamento.
router.post('/payments/picpay/create-cart', async (req, res) => {
  try {
    const b = req.body || {};
    const rawItems = Array.isArray(b.items) ? b.items : [];
    const items = rawItems
      .map((it) => ({
        productId: Number(it.productId),
        quantity: Math.floor(Number(it.quantity || 1)),
        size: it.size ? String(it.size).trim().slice(0, 80) : null,
        color: it.color ? String(it.color).trim().slice(0, 80) : null,
      }))
      .filter((it) => Number.isInteger(it.productId) && it.productId > 0 && Number.isInteger(it.quantity) && it.quantity >= 1 && it.quantity <= 20);

    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const cpf = normalizeCpf(b.cpf);
    const phone = digits(b.phone);
    const additionalData = b.additionalData ? String(b.additionalData).trim().slice(0, 1000) : null;

    if (!items.length) return res.status(400).json({ error: 'Carrinho vazio.' });
    if (items.length > 20) return res.status(400).json({ error: 'Carrinho com muitos itens.' });
    if (name.length < 3) return res.status(400).json({ error: 'Informe o nome completo.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
    if (!validCpf(cpf)) return res.status(400).json({ error: 'CPF inválido.' });
    if (!validPhone(phone)) return res.status(400).json({ error: 'Telefone inválido.' });

    const order = await db.tx(async ({ get, run }) => {
      let amount = 0;
      let totalQuantity = 0;
      const lineItems = [];
      let firstImage = null;

      for (const it of items) {
        const product = await get('SELECT * FROM products WHERE id = ? AND active = 1 FOR UPDATE', [it.productId]);
        if (!product) {
          const e = new Error('Um dos produtos do carrinho acabou ou saiu da loja.');
          e.status = 404; throw e;
        }
        const unitPrice = amountFromProduct(product);
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
          const e = new Error(`Produto "${product.name}" sem preço válido.`);
          e.status = 400; throw e;
        }
        if (Number(product.stock) < it.quantity) {
          const e = new Error(`Estoque insuficiente para "${product.name}". Disponível: ${product.stock}.`);
          e.status = 409; throw e;
        }
        await run('UPDATE products SET stock = stock - ?, updated_at = NOW() WHERE id = ?', [it.quantity, product.id]);
        const image = JSON.parse(product.images || '[]')[0] || null;
        if (!firstImage) firstImage = image;
        amount += Math.round(unitPrice * it.quantity * 100) / 100;
        totalQuantity += it.quantity;
        lineItems.push({
          productId: product.id, name: product.name, slug: product.slug, image,
          quantity: it.quantity, unitPrice, size: it.size, color: it.color,
        });
      }
      amount = Math.round(amount * 100) / 100;

      const id = crypto.randomUUID();
      const merchantChargeId = crypto.randomUUID();
      const pointsPerReal = Number(process.env.POINTS_PER_REAL || 1);
      const points = Math.floor(amount * pointsPerReal);
      const productName = lineItems.length === 1 ? lineItems[0].name : `Carrinho (${lineItems.length} itens)`;

      await run(
        `INSERT INTO orders
          (id, merchant_charge_id, product_id, product_name, product_slug, product_image,
           quantity, unit_price, amount, points, customer_name, customer_cpf, customer_email,
           customer_phone, size, color, additional_data, status, is_cart, created_at, updated_at, stock_reserved)
         VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'PENDING', 1, NOW(), NOW(), 1)`,
        [
          id, merchantChargeId, productName, firstImage, totalQuantity,
          Math.round((amount / totalQuantity) * 100) / 100, amount, points,
          name, cpf, email, phone, additionalData,
        ]
      );

      for (const li of lineItems) {
        await run(
          `INSERT INTO order_items (order_id, product_id, product_name, product_slug, product_image, quantity, unit_price, size, color)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, li.productId, li.name, li.slug, li.image, li.quantity, li.unitPrice, li.size, li.color]
        );
      }

      return { id, merchantChargeId, amount, customer: { name, email, cpf, phone }, sessionId: b.sessionId || null, items: lineItems };
    });

    let charge;
    try {
      charge = await createPixCharge({
        merchantChargeId: order.merchantChargeId,
        customer: order.customer,
        amountCents: Math.round(order.amount * 100),
        ip: getIp(req),
        sessionId: order.sessionId,
      });
    } catch (err) {
      await db.tx(async ({ run, all }) => {
        const rows = await all('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [order.id]);
        for (const r of rows) {
          if (r.product_id) await run('UPDATE products SET stock = stock + ?, updated_at = NOW() WHERE id = ?', [r.quantity, r.product_id]);
        }
        await run(`UPDATE orders SET status = 'ERROR', error_message = ?, stock_reserved = 0, updated_at = NOW() WHERE id = ?`, [err.message, order.id]);
      });
      throw err;
    }

    const transaction = Array.isArray(charge.transactions) ? charge.transactions[0] : null;
    const pix = transaction?.pix || {};
    const expiresAt = new Date(Date.now() + ((Number(process.env.PICPAY_PIX_EXPIRATION_SECONDS) || 900) * 1000)).toISOString();

    await db.run(
      `UPDATE orders SET picpay_id = ?, status = ?, pix_qr_code = ?, pix_qr_code_base64 = ?,
       pix_expires_at = ?, updated_at = NOW() WHERE id = ?`,
      [
        charge.id || null,
        charge.chargeStatus || transaction?.transactionStatus || 'PENDING',
        pix.qrCode || null,
        pix.qrCodeBase64 || null,
        expiresAt,
        order.id,
      ]
    );

    const saved = await db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
    const publicOrd = publicOrder(saved);
    publicOrd.items = order.items.map((it) => ({
      productId: it.productId, name: it.name, slug: it.slug, image: it.image,
      quantity: it.quantity, unitPrice: it.unitPrice, size: it.size, color: it.color,
    }));
    res.status(201).json(publicOrd);
  } catch (err) {
    console.error('[rshoes] create cart payment:', err);
    res.status(err.status || 500).json({ error: err.message || 'Não deu pra gerar o pagamento.' });
  }
});

router.get('/payments/orders/:id', async (req, res) => {
  const row = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const out = publicOrder(row);
  if (row.is_cart) {
    const items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [row.id]);
    out.items = items.map((it) => ({
      productId: it.product_id, name: it.product_name, slug: it.product_slug, image: it.product_image,
      quantity: it.quantity, unitPrice: Number(it.unit_price), size: it.size, color: it.color,
    }));
  }
  res.json(out);
});

function headerValue(headers, ...names) {
  for (const name of names) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (value != null) return String(value);
  }
  return '';
}

function normalizeStatus(value) {
  return String(value || '').trim().toUpperCase();
}

function extractPaidTransaction(data) {
  const transactions = Array.isArray(data?.transactions) ? data.transactions : [];
  return transactions.find((tx) => normalizeStatus(tx?.status || tx?.transactionStatus) === 'PAID') || transactions[0] || null;
}

function cents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

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
    console.error('[rshoes] WhatsApp notification failed:', err);
    return false;
  }
}

async function applyPicPayCharge({ merchantChargeId, charge, eventId = null, eventType = 'RECONCILIATION', payload = null }) {
  if (!merchantChargeId) {
    const e = new Error('merchantChargeId ausente.');
    e.status = 400;
    throw e;
  }

  let savedOrder = null;
  let wasDuplicateEvent = false;

  await db.tx(async ({ get, run, all }) => {
    const order = await get(
      'SELECT * FROM orders WHERE merchant_charge_id = ? FOR UPDATE',
      [merchantChargeId]
    );
    if (!order) {
      const e = new Error('Pedido não encontrado.');
      e.status = 404;
      throw e;
    }

    const data = charge?.data || charge || {};
    const chargeStatus = normalizeStatus(data.status || data.chargeStatus);
    const tx = extractPaidTransaction(data);
    const txStatus = normalizeStatus(tx?.status || tx?.transactionStatus);
    const paymentType = normalizeStatus(tx?.paymentType);
    const isPaid = chargeStatus === 'PAID' || txStatus === 'PAID';
    const expectedCents = Math.round(Number(order.amount) * 100);
    const receivedCents = cents(data.amount ?? tx?.amount);

    if (isPaid) {
      if (paymentType && paymentType !== 'PIX') {
        const e = new Error('Pagamento confirmado, mas a modalidade recebida não é PIX.');
        e.status = 409;
        throw e;
      }
      if (receivedCents == null || receivedCents !== expectedCents) {
        const e = new Error(`Valor divergente: esperado ${expectedCents} centavos, recebido ${receivedCents ?? 'desconhecido'}.`);
        e.status = 409;
        throw e;
      }
    }

    if (eventId) {
      const inserted = await run(
        `INSERT INTO payment_webhook_events
          (event_id, merchant_charge_id, event_type, status, payload, received_at)
         VALUES (?, ?, ?, ?, ?::jsonb, NOW())
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, merchantChargeId, eventType, chargeStatus || txStatus || null, JSON.stringify(payload || charge || {})]
      );
      wasDuplicateEvent = inserted.changes === 0;
    }

    const terminalStatuses = ['CANCELED', 'CANCELLED', 'DENIED', 'ERROR', 'EXPIRED'];
    const finalStatus = isPaid
      ? 'PAID'
      : terminalStatuses.includes(chargeStatus)
        ? chargeStatus
        : (chargeStatus || txStatus || order.status);

    const firstPaid = isPaid && order.status !== 'PAID';
    if (firstPaid) {
      await run(
        `UPDATE orders SET status='PAID', paid_at=COALESCE(paid_at, NOW()),
           transaction_id=COALESCE(?, transaction_id), picpay_status=?,
           stock_reserved=0, updated_at=NOW() WHERE id=?`,
        [tx?.transactionId || null, chargeStatus || txStatus || 'PAID', order.id]
      );

      await run(
        `INSERT INTO payment_notifications (order_id, type, status, attempts, created_at, updated_at)
         VALUES (?, 'WHATSAPP_PAYMENT_RECEIVED', 'PENDING', 0, NOW(), NOW())
         ON CONFLICT (order_id, type) DO NOTHING`,
        [order.id]
      );
    } else {
      const releasing = !isPaid && order.stock_reserved === 1 && terminalStatuses.includes(finalStatus);
      if (releasing) {
        if (order.is_cart) {
          const items = await all('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [order.id]);
          for (const it of items) {
            if (it.product_id) {
              await run(
                'UPDATE products SET stock = stock + ?, updated_at = NOW() WHERE id = ?',
                [it.quantity, it.product_id]
              );
            }
          }
        } else {
          await run(
            'UPDATE products SET stock = stock + ?, updated_at = NOW() WHERE id = ?',
            [order.quantity, order.product_id]
          );
        }
      }
      await run(
        `UPDATE orders SET status=?, picpay_status=?, transaction_id=COALESCE(?, transaction_id),
           stock_reserved=CASE WHEN ? THEN 0 ELSE stock_reserved END, updated_at=NOW() WHERE id=?`,
        [finalStatus, chargeStatus || txStatus || null, tx?.transactionId || null, releasing, order.id]
      );
    }

    if (eventId && !wasDuplicateEvent) {
      await run(
        `UPDATE payment_webhook_events SET processed_at=NOW() WHERE event_id=?`,
        [eventId]
      );
    }

    savedOrder = await get('SELECT * FROM orders WHERE id = ?', [order.id]);
  });

  // A notificação fica fora da transação. Se o WhatsApp falhar, o pagamento
  // continua confirmado e o outbox permanece PENDING para uma nova tentativa.
  if (savedOrder?.status === 'PAID') {
    await deliverPendingWhatsApp(savedOrder.id);
  }

  return { order: savedOrder, duplicateEvent: wasDuplicateEvent };
}

router.post('/payments/picpay/webhook', async (req, res) => {
  try {
    if (!verifyWebhookToken(req.headers)) {
      return res.status(401).json({ error: 'Webhook não autorizado.' });
    }

    const eventType = headerValue(req.headers, 'event_type', 'event-type');
    if (eventType !== 'TransactionUpdateMessage') {
      return res.status(400).json({ error: 'event_type inválido.' });
    }

    const body = req.body || {};
    if (body.type !== 'PAYMENT') {
      return res.status(400).json({ error: 'Tipo de evento inválido.' });
    }

    const eventId = String(body.id || '').trim();
    if (!eventId) return res.status(400).json({ error: 'ID do evento ausente.' });

    const data = body.data || {};
    const merchantChargeId = String(data.merchantChargeId || body.merchantChargeId || '').trim();
    if (!merchantChargeId) return res.status(400).json({ error: 'merchantChargeId ausente.' });

    const result = await applyPicPayCharge({
      merchantChargeId,
      charge: data,
      eventId,
      eventType,
      payload: body,
    });

    return res.status(200).json({
      received: true,
      duplicate: result.duplicateEvent,
      orderId: result.order?.id,
      status: result.order?.status,
    });
  } catch (err) {
    console.error('[rshoes] PicPay webhook:', err);
    return res.status(err.status || 500).json({ error: err.message || 'Erro no webhook.' });
  }
});

// Reconciliação manual para o administrador: consulta o estado real da charge
// diretamente no PicPay e reaplica as mesmas regras do webhook.
router.post('/admin/payments/picpay/reconcile/:merchantChargeId', async (req, res) => {
  try {
    const merchantChargeId = String(req.params.merchantChargeId || '').trim();
    if (!merchantChargeId) return res.status(400).json({ error: 'merchantChargeId ausente.' });
    const charge = await getCharge(merchantChargeId);
    const result = await applyPicPayCharge({ merchantChargeId, charge, eventType: 'RECONCILIATION', payload: charge });
    res.json({ ok: true, order: publicOrder(result.order), duplicate: result.duplicateEvent });
  } catch (err) {
    console.error('[rshoes] PicPay reconciliation:', err);
    res.status(err.status || 500).json({ error: err.message || 'Falha na reconciliação.' });
  }
});

module.exports = router;
module.exports.applyPicPayCharge = applyPicPayCharge;

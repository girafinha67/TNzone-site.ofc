'use strict';

const express = require('express');
const crypto = require('node:crypto');
const db = require('../lib/db');
const { isRateLimited, registerHit } = require('../lib/rate-limit');
const { getDefault, PaymentError, MIN_AMOUNT_CENTS } = require('../lib/payments');

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
function getIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return String(xff || req.socket?.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/, '') || '0.0.0.0';
}
function amountFromProduct(product) {
  return Number(product.promo_price != null ? product.promo_price : product.price);
}
function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const ORDER_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

// Status exibido ao cliente. O PIX vencido aparece como EXPIRED mesmo antes da
// reconciliação persistir isso no banco (que também devolve o estoque).
function effectiveStatus(row) {
  if (row.status === 'PENDING' && row.pix_expires_at && Date.now() > new Date(row.pix_expires_at).getTime()) {
    return 'EXPIRED';
  }
  return row.status;
}

function publicOrder(row) {
  const status = effectiveStatus(row);
  return {
    id: row.id,
    status,
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
    // QR e copia-e-cola só enquanto a cobrança é pagável. Vêm da resposta real do gateway.
    pix: status === 'PENDING' && row.pix_qr_code ? {
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

async function publicOrderWithItems(row) {
  const out = publicOrder(row);
  if (row.is_cart) {
    const items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [row.id]);
    out.items = items.map((it) => ({
      productId: it.product_id, name: it.product_name, slug: it.product_slug, image: it.product_image,
      quantity: it.quantity, unitPrice: Number(it.unit_price), size: it.size, color: it.color,
    }));
  }
  return out;
}

// Anti-abuso: o gateway limita 45 cobranças/min por conta; limitamos por IP antes de chegar lá.
async function checkoutRateLimit(req) {
  const ip = getIp(req);
  if (await isRateLimited('checkout', ip, 12, 10 * 60 * 1000)) {
    throw httpError('Muitas tentativas de pagamento. Aguarde alguns minutos e tente de novo.', 429);
  }
  await registerHit('checkout', ip);
}

// Reenvio do mesmo checkout (duplo clique, retry de rede): devolve o pedido já criado
// em vez de gerar outra cobrança.
async function replayByToken(token) {
  if (!token) return null;
  const existing = await getDefault().store.findOrderByToken(token);
  return existing ? publicOrderWithItems(existing) : null;
}

function readToken(body) {
  const token = body && body.checkoutToken != null ? String(body.checkoutToken).trim() : '';
  return TOKEN_PATTERN.test(token) ? token : null;
}

function isUniqueViolation(err) {
  return err && err.code === '23505';
}

async function createDirect(req, res) {
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
    const token = readToken(b);

    if (!Number.isInteger(productId) || productId <= 0) return res.status(400).json({ error: 'Produto inválido.' });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) return res.status(400).json({ error: 'Quantidade inválida.' });
    if (name.length < 3) return res.status(400).json({ error: 'Informe o nome completo.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
    if (!validCpf(cpf)) return res.status(400).json({ error: 'CPF inválido.' });
    if (!validPhone(phone)) return res.status(400).json({ error: 'Telefone inválido.' });

    const replay = await replayByToken(token);
    if (replay) return res.status(200).json(replay);

    await checkoutRateLimit(req);

    let order;
    try {
      order = await db.tx(async ({ get, run }) => {
        // O preço vem SEMPRE do banco; nada do que o navegador manda sobre valor é usado.
        const product = await get('SELECT * FROM products WHERE id = ? AND active = 1 FOR UPDATE', [productId]);
        if (!product) throw httpError('Produto não encontrado ou indisponível.', 404);
        const unitPrice = amountFromProduct(product);
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw httpError('Produto sem preço válido.', 400);
        if (Number(product.stock) < quantity) throw httpError(`Estoque insuficiente. Disponível: ${product.stock}.`, 409);

        const amount = Math.round(unitPrice * quantity * 100) / 100;
        if (Math.round(amount * 100) < MIN_AMOUNT_CENTS) throw httpError('Valor do pedido abaixo do mínimo para PIX (R$ 0,50).', 400);

        // Reserva o estoque enquanto a cobrança estiver pendente.
        await run('UPDATE products SET stock = stock - ?, updated_at = NOW() WHERE id = ?', [quantity, productId]);

        const id = crypto.randomUUID();
        const merchantChargeId = crypto.randomUUID();
        const pointsPerReal = Number(process.env.POINTS_PER_REAL || 1);
        const points = Math.floor(amount * pointsPerReal);

        await run(
          `INSERT INTO orders
            (id, merchant_charge_id, product_id, product_name, product_slug, product_image,
             quantity, unit_price, amount, points, customer_name, customer_cpf, customer_email,
             customer_phone, size, color, additional_data, status, created_at, updated_at, stock_reserved,
             payment_provider, checkout_token)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NOW(), NOW(), 1, 'promissepay', ?)`,
          [
            id, merchantChargeId, product.id, product.name, product.slug,
            JSON.parse(product.images || '[]')[0] || null, quantity, unitPrice, amount, points,
            name, cpf, email, phone, size, color, additionalData, token
          ]
        );
        return { id, amount };
      });
    } catch (err) {
      if (isUniqueViolation(err) && token) {
        const again = await replayByToken(token);
        if (again) return res.status(200).json(again);
      }
      throw err;
    }

    const saved = await getDefault().payments.startPixCharge(order);
    res.status(201).json(publicOrder(saved));
  } catch (err) {
    console.error('[rshoes] create payment:', err.message);
    res.status(err.status || 500).json({ error: err instanceof PaymentError || err.status ? err.message : 'Não deu pra gerar o pagamento.' });
  }
}

// Cobrança única para vários produtos (carrinho).
async function createCart(req, res) {
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
    const token = readToken(b);

    if (!items.length) return res.status(400).json({ error: 'Carrinho vazio.' });
    if (items.length > 20) return res.status(400).json({ error: 'Carrinho com muitos itens.' });
    if (name.length < 3) return res.status(400).json({ error: 'Informe o nome completo.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
    if (!validCpf(cpf)) return res.status(400).json({ error: 'CPF inválido.' });
    if (!validPhone(phone)) return res.status(400).json({ error: 'Telefone inválido.' });

    const replay = await replayByToken(token);
    if (replay) return res.status(200).json(replay);

    await checkoutRateLimit(req);

    let order;
    try {
      order = await db.tx(async ({ get, run }) => {
        let amount = 0;
        let totalQuantity = 0;
        const lineItems = [];
        let firstImage = null;

        for (const it of items) {
          const product = await get('SELECT * FROM products WHERE id = ? AND active = 1 FOR UPDATE', [it.productId]);
          if (!product) throw httpError('Um dos produtos do carrinho acabou ou saiu da loja.', 404);
          const unitPrice = amountFromProduct(product);
          if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw httpError(`Produto "${product.name}" sem preço válido.`, 400);
          if (Number(product.stock) < it.quantity) throw httpError(`Estoque insuficiente para "${product.name}". Disponível: ${product.stock}.`, 409);
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
        if (Math.round(amount * 100) < MIN_AMOUNT_CENTS) throw httpError('Valor do pedido abaixo do mínimo para PIX (R$ 0,50).', 400);

        const id = crypto.randomUUID();
        const merchantChargeId = crypto.randomUUID();
        const pointsPerReal = Number(process.env.POINTS_PER_REAL || 1);
        const points = Math.floor(amount * pointsPerReal);
        const productName = lineItems.length === 1 ? lineItems[0].name : `Carrinho (${lineItems.length} itens)`;

        await run(
          `INSERT INTO orders
            (id, merchant_charge_id, product_id, product_name, product_slug, product_image,
             quantity, unit_price, amount, points, customer_name, customer_cpf, customer_email,
             customer_phone, size, color, additional_data, status, is_cart, created_at, updated_at, stock_reserved,
             payment_provider, checkout_token)
           VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'PENDING', 1, NOW(), NOW(), 1, 'promissepay', ?)`,
          [
            id, merchantChargeId, productName, firstImage, totalQuantity,
            Math.round((amount / totalQuantity) * 100) / 100, amount, points,
            name, cpf, email, phone, additionalData, token,
          ]
        );

        for (const li of lineItems) {
          await run(
            `INSERT INTO order_items (order_id, product_id, product_name, product_slug, product_image, quantity, unit_price, size, color)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, li.productId, li.name, li.slug, li.image, li.quantity, li.unitPrice, li.size, li.color]
          );
        }
        return { id, amount };
      });
    } catch (err) {
      if (isUniqueViolation(err) && token) {
        const again = await replayByToken(token);
        if (again) return res.status(200).json(again);
      }
      throw err;
    }

    const saved = await getDefault().payments.startPixCharge(order);
    res.status(201).json(await publicOrderWithItems(saved));
  } catch (err) {
    console.error('[rshoes] create cart payment:', err.message);
    res.status(err.status || 500).json({ error: err instanceof PaymentError || err.status ? err.message : 'Não deu pra gerar o pagamento.' });
  }
}

// Rotas novas + aliases das rotas antigas (páginas em cache do navegador continuam funcionando).
router.post(['/payments/pix/create', '/payments/picpay/create'], createDirect);
router.post(['/payments/pix/create-cart', '/payments/picpay/create-cart'], createCart);

// Consulta do pedido. O navegador só LÊ o estado gravado no servidor; nenhum parâmetro
// da URL ou do cliente altera o status. Se o pedido ainda está pendente, o servidor
// reconfirma na API da PromissePay (no máximo 1 consulta a cada 10 s por pedido).
router.get('/payments/orders/:id', async (req, res) => {
  try {
    if (!ORDER_ID_PATTERN.test(String(req.params.id || ''))) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const { payments, store } = getDefault();
    let row = await store.findOrderById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (row.status === 'PENDING') row = (await payments.refreshOrder(row)) || row;
    res.json(await publicOrderWithItems(row));
  } catch (err) {
    console.error('[rshoes] order status:', err.message);
    res.status(500).json({ error: 'Não deu pra consultar o pedido.' });
  }
});

// Reconciliação manual (admin): consulta o estado real na PromissePay e aplica as mesmas regras do webhook.
router.post('/admin/payments/reconcile/:orderId', async (req, res) => {
  try {
    const { payments, store } = getDefault();
    const row = await store.findOrderById(String(req.params.orderId || ''));
    if (!row) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const after = await payments.refreshOrder(row, { force: true });
    res.json({ ok: true, order: publicOrder(after || row) });
  } catch (err) {
    console.error('[rshoes] reconciliation:', err.message);
    res.status(err.status || 502).json({ error: 'Falha na reconciliação com a PromissePay.' });
  }
});

module.exports = router;

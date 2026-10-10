'use strict';

// Testes automatizados. Usam FAKES (ver tests/helpers.js) para a API da PromissePay e para o banco.
// Não fazem chamadas reais, não confirmam pagamento real e não executam SQL no Postgres.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createClient, verifyWebhookSignature, GatewayError } = require('../netlify/functions/lib/promissepay');
const { createPayments, PaymentError } = require('../netlify/functions/lib/payments');
const { processWebhook } = require('../netlify/functions/lib/promissepay-webhook');
const H = require('./helpers');

const ENV = { PROMISSEPAY_API_KEY: H.API_KEY, PROMISSEPAY_WEBHOOK_SECRET: H.WEBHOOK_SECRET, PROMISSEPAY_TIMEOUT_MS: '200' };

function setup({ orders, stock, routes = {}, notify } = {}) {
  const store = H.makeFakeStore({ orders, stock });
  const fetchImpl = H.makeFakeFetch(routes);
  const client = createClient({ env: ENV, fetchImpl });
  const log = H.makeLogger();
  const notified = [];
  const payments = createPayments({ store, client, log, notifyPaid: notify || (async (id) => { notified.push(id); }) });
  const webhook = (event, { id = H.TX_A, secret = H.WEBHOOK_SECRET, signature, raw } = {}) => {
    const body = raw !== undefined ? Buffer.from(raw) : Buffer.from(JSON.stringify({ event, timestamp: new Date().toISOString(), data: { id, status: 'PAID', type: 'DEPOSIT', amount: 14990 } }));
    const sig = signature === undefined ? H.sign(body, H.WEBHOOK_SECRET) : signature;
    return processWebhook({ payments, client, store, secret, log }, { rawBody: body, headers: sig === null ? {} : { 'Promisse-Signature': sig } });
  };
  return { store, fetchImpl, client, log, payments, notified, webhook };
}

// ------------------------------------------------------------------ criação de cobrança
test('cria cobrança PIX: endpoint, header cru, corpo e dados do gateway', async () => {
  const s = setup({ orders: [H.makeOrder({ promisse_id: null })], routes: { 'POST /transactions': H.goodCreate(14990) } });
  const out = await s.payments.startPixCharge(s.store.state.orders.get('order-A'));
  const call = s.fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.promisse.com.br/transactions');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, H.API_KEY, 'chave vai crua, sem Bearer');
  assert.deepEqual(JSON.parse(call.body), { amount: 14990 });
  assert.equal(out.promisse_id, H.TX_A);
  assert.equal(out.pix_qr_code, '00020126580014br.gov.bcb.pix6304ABCD');
  assert.match(out.pix_qr_code_base64, /^data:image\/png;base64,/);
  assert.equal(out.status, 'PENDING');
});

test('falha de comunicação: pedido vira ERROR, estoque volta, erro público sem detalhes', async () => {
  const s = setup({ orders: [H.makeOrder({ promisse_id: null })], stock: { 1: 8 }, routes: { 'POST /transactions': new Error('ECONNRESET') } });
  await assert.rejects(() => s.payments.startPixCharge(s.store.state.orders.get('order-A')), (e) => e instanceof PaymentError && e.status === 502);
  const o = s.store.state.orders.get('order-A');
  assert.equal(o.status, 'ERROR');
  assert.equal(o.stock_reserved, 0);
  assert.equal(s.store.state.stock[1], 10, 'reserva de 2 unidades devolvida');
  assert.equal(s.fetchImpl.calls.length, 1, 'POST não é repetido automaticamente');
});

test('timeout da API: GATEWAY_TIMEOUT, sem retry, estoque devolvido', async () => {
  const s = setup({ orders: [H.makeOrder({ promisse_id: null })], stock: { 1: 8 }, routes: { 'POST /transactions': 'hang' } });
  await assert.rejects(() => s.payments.startPixCharge(s.store.state.orders.get('order-A')), (e) => e.status === 504 && e.code === 'GATEWAY_TIMEOUT');
  assert.equal(s.store.state.orders.get('order-A').status, 'ERROR');
  assert.equal(s.store.state.stock[1], 10);
  assert.equal(s.fetchImpl.calls.length, 1);
});

for (const [nome, body] of [
  ['sem copia-e-cola', { copyPaste: undefined }],
  ['sem QR Code', { qrCodeBase64: undefined }],
  ['sem id', { id: undefined }],
  ['valor diferente do solicitado', { amount: 1 }],
  ['status diferente de pending', { status: 'paid' }],
]) {
  test(`resposta inválida do gateway (${nome}) é rejeitada e nunca vira QR`, async () => {
    const s = setup({ orders: [H.makeOrder({ promisse_id: null })], routes: { 'POST /transactions': H.goodCreate(14990, body) } });
    await assert.rejects(() => s.payments.startPixCharge(s.store.state.orders.get('order-A')), (e) => e instanceof PaymentError && e.status === 502);
    const o = s.store.state.orders.get('order-A');
    assert.equal(o.status, 'ERROR');
    assert.equal(o.pix_qr_code, undefined);
  });
}

test('resposta não-JSON do gateway é rejeitada', async () => {
  const client = createClient({ env: ENV, fetchImpl: H.makeFakeFetch({ 'POST /transactions': { status: 201, raw: '<html>oops</html>' } }) });
  await assert.rejects(() => client.createPixCharge({ amountCents: 100 }), (e) => e instanceof GatewayError && e.gatewayCode === 'INVALID_GATEWAY_RESPONSE');
});

test('erros documentados: 429 vira "tente novamente"; 401 não vaza a chave', async () => {
  const s1 = setup({ orders: [H.makeOrder({ promisse_id: null })], routes: { 'POST /transactions': { status: 429, body: { status: 'error', code: 'TOO_MANY_REQUESTS', message: 'x' } } } });
  await assert.rejects(() => s1.payments.startPixCharge(s1.store.state.orders.get('order-A')), (e) => e.status === 429);
  const s2 = setup({ orders: [H.makeOrder({ promisse_id: null })], routes: { 'POST /transactions': { status: 401, body: { status: 'error', code: 'ACCESS_FORBIDDEN', message: 'Chave inválida' } } } });
  await assert.rejects(() => s2.payments.startPixCharge(s2.store.state.orders.get('order-A')), (e) => e.status === 502 && !e.message.includes('sk_live'));
});

test('valor abaixo de 50 centavos nem chega ao gateway', async () => {
  const s = setup({ orders: [H.makeOrder({ promisse_id: null, amount: 0.3 })] });
  await assert.rejects(() => s.payments.startPixCharge(s.store.state.orders.get('order-A')), (e) => e.status === 400);
  assert.equal(s.fetchImpl.calls.length, 0);
});

test('chave de API e secret nunca aparecem nos logs', async () => {
  const s = setup({ orders: [H.makeOrder({ promisse_id: null })], routes: { 'POST /transactions': { status: 401, body: { code: 'ACCESS_FORBIDDEN', message: 'nope' } } } });
  await assert.rejects(() => s.payments.startPixCharge(s.store.state.orders.get('order-A')));
  await s.webhook('payment.approved', { signature: 'sha256=bad' });
  const all = s.log.lines.join('\n');
  assert.ok(!all.includes(H.API_KEY) && !all.includes(H.WEBHOOK_SECRET));
});

// ------------------------------------------------------------------ assinatura
test('verifyWebhookSignature: HMAC-SHA256 do corpo bruto, formato sha256=<hex>', () => {
  const raw = Buffer.from('{"event":"payment.approved","data":{"id":"x"}}');
  const good = 'sha256=' + crypto.createHmac('sha256', 's3').update(raw).digest('hex');
  assert.equal(verifyWebhookSignature(raw, good, 's3'), true);
  assert.equal(verifyWebhookSignature(raw, good, 'outra'), false);
  assert.equal(verifyWebhookSignature(raw, good.replace('sha256=', ''), 's3'), false, 'sem prefixo');
  assert.equal(verifyWebhookSignature(raw, 'sha256=abc', 's3'), false, 'tamanho diferente não lança');
  assert.equal(verifyWebhookSignature(raw, undefined, 's3'), false);
  assert.equal(verifyWebhookSignature(raw, good, ''), false);
});

test('a assinatura vale para o corpo BRUTO (espaços/ordem preservados)', async () => {
  const s = setup({ routes: { ['GET /transactions/' + H.TX_A]: H.goodGet() } });
  const raw = `{ "data": {"amount": 14990, "id": "${H.TX_A}" },\n "event":"payment.approved" }`;
  const r = await s.webhook('x', { raw });
  assert.equal(r.statusCode, 200);
  assert.equal(s.store.state.orders.get('order-A').status, 'PAID');
});

// ------------------------------------------------------------------ webhook
test('webhook válido + confirmação na API: pedido PENDING -> PAID, notificação enfileirada e enviada', async () => {
  const s = setup({ routes: { ['GET /transactions/' + H.TX_A]: H.goodGet() } });
  const r = await s.webhook('payment.approved');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.duplicate, false);
  const o = s.store.state.orders.get('order-A');
  assert.equal(o.status, 'PAID');
  assert.equal(o.transaction_id, H.TX_A);
  assert.equal(s.store.state.stock[1], 10, 'estoque já estava reservado; não é debitado de novo');
  assert.deepEqual([...s.store.state.notifications], ['order-A']);
  assert.deepEqual(s.notified, ['order-A']);
  assert.equal(s.fetchImpl.calls[0].headers.Authorization, H.API_KEY);
});

test('assinatura inválida, ausente ou de outro segredo: 401 e nada muda', async () => {
  const s = setup({ routes: { ['GET /transactions/' + H.TX_A]: H.goodGet() } });
  for (const opt of [{ signature: 'sha256=' + '0'.repeat(64) }, { signature: null }, { signature: H.sign(Buffer.from('outro corpo')) }]) {
    const r = await s.webhook('payment.approved', opt);
    assert.equal(r.statusCode, 401);
  }
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
  assert.equal(s.fetchImpl.calls.length, 0, 'nem consulta a API antes de validar a assinatura');
});

test('sem PROMISSEPAY_WEBHOOK_SECRET o webhook recusa tudo (500)', async () => {
  const s = setup();
  const r = await s.webhook('payment.approved', { secret: '' });
  assert.equal(r.statusCode, 500);
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
});

test('notificação duplicada: segunda entrega é idempotente (200, duplicate, sem efeitos)', async () => {
  const s = setup({ routes: { ['GET /transactions/' + H.TX_A]: H.goodGet() } });
  assert.equal((await s.webhook('payment.approved')).body.duplicate, false);
  const second = await s.webhook('payment.approved');
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(s.notified.length, 1);
  assert.equal(s.store.state.events.size, 1);
});

test('pedido inexistente: 404 (e não consulta a API)', async () => {
  const s = setup({ routes: { 'GET /transactions/*': H.goodGet() } });
  const r = await s.webhook('payment.approved', { id: H.TX_B });
  assert.equal(r.statusCode, 404);
  assert.equal(s.fetchImpl.calls.length, 0);
});

test('valor divergente na API: 409, pedido segue PENDING e o evento pode ser reenviado', async () => {
  const s = setup({ routes: { ['GET /transactions/' + H.TX_A]: H.goodGet({ amount: 100 }) } });
  const r = await s.webhook('payment.approved');
  assert.equal(r.statusCode, 409);
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
  assert.equal(s.store.state.events.size, 0, 'rollback: evento não ficou marcado como processado');
  assert.equal(s.notified.length, 0);
});

test('tipo da transação diferente de DEPOSIT: 409', async () => {
  const s = setup({ routes: { ['GET /transactions/' + H.TX_A]: H.goodGet({ type: 'WITHDRAWAL' }) } });
  assert.equal((await s.webhook('payment.approved')).statusCode, 409);
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
});

test('pagamento pendente: webhook diz approved mas a API diz PENDING -> 503, nada muda', async () => {
  const s = setup({ routes: { ['GET /transactions/' + H.TX_A]: H.goodGet({ status: 'PENDING' }) } });
  const r = await s.webhook('payment.approved');
  assert.equal(r.statusCode, 503);
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
});

test('payload com status forjado não prova pagamento: vale só o que a API confirma', async () => {
  // O payload assinado já traz status PAID; a API diz PENDING.
  const s = setup({ routes: { ['GET /transactions/' + H.TX_A]: H.goodGet({ status: 'PENDING' }) } });
  await s.webhook('payment.approved');
  assert.notEqual(s.store.state.orders.get('order-A').status, 'PAID');
});

test('falha ao consultar a API durante o webhook: 502 (fail closed), pedido não é pago', async () => {
  const s = setup({ routes: { ['GET /transactions/' + H.TX_A]: new Error('network down') } });
  const r = await s.webhook('payment.approved');
  assert.equal(r.statusCode, 502);
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
});

test('resposta da API com id de outra transação é rejeitada (um pedido não altera outro)', async () => {
  const s = setup({ routes: { ['GET /transactions/' + H.TX_A]: H.goodGet({ id: H.TX_B }) } });
  const r = await s.webhook('payment.approved');
  assert.equal(r.statusCode, 502);
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
});

test('isolamento: evento da transação A só altera o pedido A', async () => {
  const orderB = H.makeOrder({ id: 'order-B', merchant_charge_id: 'mc-B', promisse_id: H.TX_B });
  const s = setup({ orders: [H.makeOrder(), orderB], routes: { ['GET /transactions/' + H.TX_A]: H.goodGet() } });
  await s.webhook('payment.approved');
  assert.equal(s.store.state.orders.get('order-A').status, 'PAID');
  assert.equal(s.store.state.orders.get('order-B').status, 'PENDING');
});

test('payment.failed encerra o pedido pendente e devolve o estoque', async () => {
  const s = setup({ stock: { 1: 8 } });
  const r = await s.webhook('payment.failed');
  assert.equal(r.statusCode, 200);
  const o = s.store.state.orders.get('order-A');
  assert.equal(o.status, 'FAILED');
  assert.equal(s.store.state.stock[1], 10);
});

test('payment.failed depois de PAID nunca desfaz o pagamento', async () => {
  const s = setup({ orders: [H.makeOrder({ status: 'PAID', stock_reserved: 0 })] });
  await s.webhook('payment.failed');
  assert.equal(s.store.state.orders.get('order-A').status, 'PAID');
});

test('webhook.test (cadastro) responde 200 sem alterar nada; evento desconhecido é ignorado com 200', async () => {
  const s = setup();
  const t = await processWebhook({ payments: s.payments, client: s.client, store: s.store, secret: H.WEBHOOK_SECRET, log: s.log }, { rawBody: Buffer.from('{"event":"webhook.test"}'), headers: {} });
  assert.equal(t.statusCode, 200);
  const ign = await s.webhook('transfer-approved');
  assert.equal(ign.statusCode, 200);
  assert.equal(ign.body.ignored, true);
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
});

test('corpo que não é JSON (com assinatura válida) -> 400; id inválido -> 400', async () => {
  const s = setup();
  assert.equal((await s.webhook('x', { raw: 'não é json' })).statusCode, 400);
  assert.equal((await s.webhook('payment.approved', { id: '../../etc' })).statusCode, 400);
});

// ------------------------------------------------------------------ estados / reconciliação / repetição
test('pagamento tardio após expiração: reserva o estoque de novo e marca PAID', async () => {
  const s = setup({ orders: [H.makeOrder({ status: 'EXPIRED', stock_reserved: 0 })], stock: { 1: 10 }, routes: { ['GET /transactions/' + H.TX_A]: H.goodGet() } });
  await s.webhook('payment.approved');
  const o = s.store.state.orders.get('order-A');
  assert.equal(o.status, 'PAID');
  assert.equal(s.store.state.stock[1], 8);
  assert.equal(o.error_message, null);
});

test('pagamento tardio sem estoque: continua PAID (dinheiro recebido) e sinaliza revisão', async () => {
  const s = setup({ orders: [H.makeOrder({ status: 'EXPIRED', stock_reserved: 0 })], stock: { 1: 0 }, routes: { ['GET /transactions/' + H.TX_A]: H.goodGet() } });
  await s.webhook('payment.approved');
  const o = s.store.state.orders.get('order-A');
  assert.equal(o.status, 'PAID');
  assert.match(o.error_message, /revisar/);
});

test('pedido vencido e não pago: refresh marca EXPIRED e devolve o estoque', async () => {
  const past = new Date(Date.now() - 10 * 60000).toISOString();
  const s = setup({ orders: [H.makeOrder({ pix_expires_at: past })], stock: { 1: 8 }, routes: { ['GET /transactions/' + H.TX_A]: H.goodGet({ status: 'PENDING' }) } });
  const after = await s.payments.refreshOrder(s.store.state.orders.get('order-A'));
  assert.equal(after.status, 'EXPIRED');
  assert.equal(s.store.state.stock[1], 10);
});

test('pedido ainda dentro do prazo e PENDING na API continua PENDING', async () => {
  const s = setup({ routes: { ['GET /transactions/' + H.TX_A]: H.goodGet({ status: 'PENDING' }) } });
  const after = await s.payments.refreshOrder(s.store.state.orders.get('order-A'));
  assert.equal(after.status, 'PENDING');
});

test('status desconhecido do gateway é só registrado: o pedido não muda por ele', async () => {
  const s = setup({ routes: { ['GET /transactions/' + H.TX_A]: H.goodGet({ status: 'SOMETHING_NEW' }) } });
  const after = await s.payments.refreshOrder(s.store.state.orders.get('order-A'));
  assert.equal(after.status, 'PENDING');
  assert.equal(after.promisse_status, 'SOMETHING_NEW');
});

test('consultas repetidas do navegador: no máximo 1 chamada à API por janela (throttle)', async () => {
  const s = setup({ routes: { ['GET /transactions/' + H.TX_A]: H.goodGet({ status: 'PENDING' }) } });
  for (let i = 0; i < 5; i++) await s.payments.refreshOrder(s.store.state.orders.get('order-A'));
  assert.equal(s.fetchImpl.calls.length, 1);
});

test('refresh confirma pagamento pela API (sem webhook) e é idempotente', async () => {
  const s = setup({ routes: { ['GET /transactions/' + H.TX_A]: H.goodGet() } });
  const a = await s.payments.refreshOrder(s.store.state.orders.get('order-A'), { force: true });
  assert.equal(a.status, 'PAID');
  const b = await s.payments.refreshOrder(s.store.state.orders.get('order-A'), { force: true });
  assert.equal(b.status, 'PAID');
  assert.equal(s.notified.length, 1);
});

test('reconciliação agendada: paga, expirada e com erro são contadas', async () => {
  const past = new Date(Date.now() - 10 * 60000).toISOString();
  const T3 = 'cccccccc-2222-4333-8444-555555555555';
  const s = setup({
    orders: [H.makeOrder(), H.makeOrder({ id: 'order-B', promisse_id: H.TX_B, pix_expires_at: past }), H.makeOrder({ id: 'order-C', promisse_id: T3 })],
    routes: {
      ['GET /transactions/' + H.TX_A]: H.goodGet(),
      ['GET /transactions/' + H.TX_B]: H.goodGet({ id: H.TX_B, status: 'PENDING' }),
      ['GET /transactions/' + T3]: new Error('down'),
    },
  });
  const sum = await s.payments.reconcilePending();
  assert.deepEqual({ checked: sum.checked, paid: sum.paid, expired: sum.expired, failed: sum.failed }, { checked: 3, paid: 1, expired: 1, failed: 1 });
});

// ------------------------------------------------------------------ proteção contra o cliente
test('não existe rota/handler que aceite status vindo do navegador', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../netlify/functions/routes/orders.routes.js'), 'utf8');
  const routes = [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*(\[[^\]]+\]|'[^']+')/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.equal(routes.filter((r) => /^(PUT|PATCH|DELETE)/.test(r)).length, 0);
  assert.ok(routes.some((r) => r.startsWith('GET') && r.includes('/payments/orders/:id')));
  assert.ok(!/req\.(body|query|params)\.status/.test(src), 'nenhum status é lido da requisição');
  assert.ok(!/picpay\/webhook/.test(src), 'rota de webhook antiga não existe mais');
});

test('a Netlify Function do webhook só aceita POST', async () => {
  const { handler } = require('../netlify/functions/promissepay-webhook');
  const r = await handler({ httpMethod: 'GET', headers: {}, body: null });
  assert.equal(r.statusCode, 405);
  assert.equal(r.headers.Allow, 'POST');
});

test('WhatsApp via CallMeBot: monta a URL com texto codificado (fetch falso, sem rede)', async () => {
  const wa = require('../netlify/functions/lib/whatsapp');
  const saved = { fetch: globalThis.fetch, k: process.env.CALLMEBOT_API_KEY, p: process.env.WHATSAPP_OWNER_PHONE };
  let seen;
  globalThis.fetch = async (url) => { seen = url; return { ok: true, status: 200, text: async () => 'Message queued' }; };
  process.env.CALLMEBOT_API_KEY = 'KEY123'; process.env.WHATSAPP_OWNER_PHONE = '+55 61 98655-3995';
  try {
    const r = await wa.notifyOwner('Total R$ 10,00 & mais');
    assert.equal(r.sent, true);
    assert.ok(seen.startsWith('https://api.callmebot.com/whatsapp.php?phone=5561986553995&text='));
    assert.ok(seen.includes('R%24%2010') && seen.includes('%26') && seen.endsWith('&apikey=KEY123'));
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.k === undefined) delete process.env.CALLMEBOT_API_KEY; else process.env.CALLMEBOT_API_KEY = saved.k;
    if (saved.p === undefined) delete process.env.WHATSAPP_OWNER_PHONE; else process.env.WHATSAPP_OWNER_PHONE = saved.p;
  }
});

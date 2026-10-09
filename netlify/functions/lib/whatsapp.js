'use strict';

async function notifyOwner(message) {
  const url = process.env.WHATSAPP_API_URL;
  const token = process.env.WHATSAPP_TOKEN;
  const to = String(process.env.WHATSAPP_OWNER_PHONE || '').replace(/\D/g, '');

  if (!url || !token || !to) {
    console.warn('[rshoes] WhatsApp não configurado; notificação ignorada.');
    return { sent: false, reason: 'not_configured' };
  }

  // Compatível com a WhatsApp Cloud API da Meta e provedores que aceitam
  // o mesmo formato de envio de texto.
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: false, body: message },
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Falha ao enviar WhatsApp (${response.status}): ${data.error?.message || data.message || 'erro desconhecido'}`);
  }
  return { sent: true, data };
}

function formatPaidOrder(order, items) {
  const money = Number(order.amount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const when = new Date(order.paid_at || order.updated_at || Date.now())
    .toLocaleString('pt-BR', { timeZone: process.env.TZ || 'America/Fortaleza' });

  const itemLines = Array.isArray(items) && items.length
    ? [
        `*Itens (${items.length}):*`,
        ...items.map((it) => {
          const variant = [it.size ? `tam. ${it.size}` : null, it.color ? it.color : null].filter(Boolean).join(', ');
          return `• ${it.quantity}x ${it.product_name}${variant ? ` (${variant})` : ''}`;
        }),
      ]
    : [
        `*Produto:* ${order.product_name}`,
        `*Quantidade:* ${order.quantity}`,
      ];

  return [
    '🛍️ *PAGAMENTO RECEBIDO | TN\'ZONE*',
    '',
    `*Pedido:* ${order.id}`,
    ...itemLines,
    `*Pontuação:* ${order.points}`,
    `*Valor:* ${money}`,
    '',
    '*Cliente*',
    `Nome: ${order.customer_name}`,
    `CPF: ${order.customer_cpf}`,
    `E-mail: ${order.customer_email}`,
    `Telefone: ${order.customer_phone}`,
    order.size ? `Tamanho: ${order.size}` : null,
    order.color ? `Cor: ${order.color}` : null,
    order.additional_data ? `Dados adicionais: ${order.additional_data}` : null,
    '',
    `*Status:* PAGAMENTO EFETUADO`,
    `*Horário:* ${when}`,
    `*PicPay Charge:* ${order.merchant_charge_id}`,
  ].filter(Boolean).join('\n');
}

module.exports = { notifyOwner, formatPaidOrder };

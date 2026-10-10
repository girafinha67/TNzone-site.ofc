'use strict';

// Rede de segurança (agendada no netlify.toml): reconsulta na PromissePay os pedidos
// ainda PENDING e encerra os expirados/órfãos. O caminho principal continua sendo o webhook.

const db = require('./lib/db');
const { getDefault } = require('./lib/payments');

exports.handler = async () => {
  await db.init();
  const { payments } = getDefault();
  const summary = await payments.reconcilePending({ limit: 20 });
  console.log('[rshoes] Reconciliação PromissePay:', JSON.stringify(summary));
  return summary;
};

'use strict';

const db = require('./lib/db');
const { getCharge } = require('./lib/picpay');
const { applyPicPayCharge } = require('./routes/orders.routes');

exports.handler = async () => {
  await db.init();

  const pending = await db.all(`
    SELECT merchant_charge_id
      FROM orders
     WHERE status = 'PENDING'
       AND created_at < NOW() - INTERVAL '2 minutes'
       AND created_at > NOW() - INTERVAL '1 day'
     ORDER BY created_at ASC
     LIMIT 10
  `);

  let checked = 0;
  let paid = 0;
  let failed = 0;

  for (const row of pending) {
    checked += 1;
    try {
      const charge = await getCharge(row.merchant_charge_id);
      const result = await applyPicPayCharge({
        merchantChargeId: row.merchant_charge_id,
        charge,
        eventType: 'RECONCILIATION',
        payload: charge,
      });
      if (result.order?.status === 'PAID') paid += 1;
    } catch (err) {
      failed += 1;
      console.error(`[rshoes] Falha ao reconciliar ${row.merchant_charge_id}:`, err.message);
    }
  }

  console.log(`[rshoes] Reconciliação PicPay: ${checked} verificadas, ${paid} pagas, ${failed} falhas.`);
  return { checked, paid, failed };
};

'use strict';

// Rate limiting baseado em Postgres (tabela rate_hits), em vez de um Map em
// memória. Necessário porque Netlify Functions são serverless: cada cold
// start zera qualquer estado em memória, então um limitador só-em-memória
// pode ser contornado facilmente. Este é leve o suficiente (uma query
// indexada por bucket+ip+created_at) para não pesar no tempo de resposta.

const db = require('./db');

async function isRateLimited(bucket, ip, maxAttempts, windowMs) {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM rate_hits WHERE bucket = ? AND ip = ? AND created_at > ?',
    [bucket, ip, since]
  );
  return Number(row.n) >= maxAttempts;
}

async function registerHit(bucket, ip) {
  await db.run('INSERT INTO rate_hits (bucket, ip) VALUES (?, ?)', [bucket, ip || 'unknown']);
}

async function clearHits(bucket, ip) {
  await db.run('DELETE FROM rate_hits WHERE bucket = ? AND ip = ?', [bucket, ip]);
}

module.exports = { isRateLimited, registerHit, clearHits };

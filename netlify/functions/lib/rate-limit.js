'use strict';

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

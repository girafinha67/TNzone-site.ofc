'use strict';

const { Pool } = require('pg');
const crypto = require('node:crypto');

const databaseUrl = process.env.SUPABASE_DB_POOLER_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn('[tn-zone] SUPABASE_DB_POOLER_URL não definida — configure a connection string do Supabase nas env vars do Netlify.');
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl && databaseUrl.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

// Converte placeholders estilo SQLite ("?") para o formato do Postgres ($1, $2...)
function toPgQuery(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function all(sql, params = []) {
  const { rows } = await pool.query(toPgQuery(sql), params);
  return rows;
}

async function get(sql, params = []) {
  const { rows } = await pool.query(toPgQuery(sql), params);
  return rows[0] || null;
}

// INSERT/UPDATE/DELETE. Para INSERT sem RETURNING explícito em tabelas com
// coluna id, adiciona "RETURNING id" para imitar o lastInsertRowid do node:sqlite.
function addInsertReturningId(sql) {
  const isInsert = /^\s*INSERT/i.test(sql);
  const isSettingsInsert = /^\s*INSERT\s+INTO\s+settings\b/i.test(sql);
  return isInsert && !isSettingsInsert && !/RETURNING/i.test(sql) ? `${sql} RETURNING id` : sql;
}

async function run(sql, params = []) {
  const q = addInsertReturningId(toPgQuery(sql));
  const res = await pool.query(q, params);
  return {
    lastInsertRowid: res.rows[0] ? res.rows[0].id : undefined,
    changes: res.rowCount,
  };
}

async function exec(sql) {
  await pool.query(sql);
}

// Transação simples: fn recebe { get, all, run } ligados a um client dedicado.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scoped = {
      get: async (sql, params = []) => (await client.query(toPgQuery(sql), params)).rows[0] || null,
      all: async (sql, params = []) => (await client.query(toPgQuery(sql), params)).rows,
      run: async (sql, params = []) => {
        const q = addInsertReturningId(toPgQuery(sql));
        const res = await client.query(q, params);
        return { lastInsertRowid: res.rows[0] ? res.rows[0].id : undefined, changes: res.rowCount };
      },
    };
    const result = await fn(scoped);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------- Schema + seed (idempotente, roda uma vez por container "quente") ----------
let initPromise = null;

async function ensureSchema() {
  await exec(`
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_ip TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  image TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'outro',
  description TEXT,
  price REAL NOT NULL DEFAULT 0,
  promo_price REAL,
  sizes TEXT NOT NULL DEFAULT '[]',
  colors TEXT NOT NULL DEFAULT '[]',
  images TEXT NOT NULL DEFAULT '[]',
  stock INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feedbacks (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  rating INTEGER NOT NULL,
  comment TEXT,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Registro de "hits" para rate limiting (login, envio de feedback, etc.).
-- Compatível com serverless: sobrevive a cold starts, diferente de um Map em memória.
CREATE TABLE IF NOT EXISTS rate_hits (
  id SERIAL PRIMARY KEY,
  bucket TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
  `);

  // Índices — criados fora do bloco acima para poder usar IF NOT EXISTS de
  // forma independente e não falhar caso alguma já exista de um deploy anterior.
  await exec(`
CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_products_active_created ON products(active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug);
CREATE INDEX IF NOT EXISTS idx_categories_active_order ON categories(active, order_index);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedbacks_product ON feedbacks(product_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_admin ON sessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rate_hits_lookup ON rate_hits(bucket, ip, created_at);
  `);
}

async function seed() {
  const catCount = (await get('SELECT COUNT(*) AS n FROM categories')).n;
  if (Number(catCount) === 0) {
    const insertCat = 'INSERT INTO categories (name, slug, order_index, active) VALUES (?, ?, ?, 1)';
    await run(insertCat, ['Tênis', 'tenis', 1]);
    await run(insertCat, ['Camisas', 'camisas', 2]);
    await run(insertCat, ['Calças', 'calcas', 3]);
    await run(insertCat, ['Novidades', 'novidades', 4]);
  }

  const defaultSettings = {
    store_name: 'TN Zone',
    tagline: 'Streetwear e sneakers selecionados.',
    whatsapp_number: '5561986553995',
    instagram: 'tnzone.ofc',
    email_contact: '',
    logo_url: '/img/logo-mark.png',
    favicon_url: '/img/favicon.png',
    primary_color: '#375BFF',
    banner_title: 'A curadoria certa para o seu próximo par.',
    banner_subtitle: 'Tênis, camisas e calças selecionados — direto no seu Instagram.',
    banner_image: '',
    footer_text: 'TN Zone — loja nova de tênis e streetwear, tocada por dois amigos e um sonho.',
    home_sections_order: JSON.stringify(['banner', 'categorias', 'destaques', 'novidades', 'feedbacks']),
  };
  for (const [k, v] of Object.entries(defaultSettings)) {
    await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [k, String(v)]);
  }
}

// Verifica senha usando o mesmo método de scrypt do lib/auth.js. Implementado
// aqui (em vez de importar auth.js) para evitar dependência circular, já que
// auth.js já faz require('./db').
function verifyPasswordScrypt(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Garante que existe exatamente um administrador e que ele usa as
// credenciais definidas em ADMIN_EMAIL / ADMIN_PASSWORD (Netlify env vars).
//
// - Se não houver nenhum admin: cria um novo com essas credenciais.
// - Se já houver admin: ATUALIZA o registro existente (nunca cria outro),
//   trocando e-mail/hash/salt somente quando eles realmente diferem do que
//   está configurado — assim uma nova invocação não fica reescrevendo o
//   banco à toa, mas o estado final sempre bate com as env vars atuais.
// - Nunca grava a senha em texto puro (só o hash scrypt) nem em log.
async function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn(
      '[tn-zone] ADMIN_EMAIL/ADMIN_PASSWORD não definidos — configure-os nas ' +
      'variáveis de ambiente do Netlify para criar/atualizar o administrador.'
    );
    return;
  }
  const normalizedEmail = email.toLowerCase().trim();

  // Sempre o admin mais antigo (menor id) — o sistema opera com um único
  // administrador fixo.
  const existing = await get('SELECT * FROM admins ORDER BY id ASC LIMIT 1');

  if (!existing) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    await run('INSERT INTO admins (email, password_hash, salt) VALUES (?, ?, ?)', [
      normalizedEmail,
      hash,
      salt,
    ]);
    console.log(`[tn-zone] Administrador inicial criado: ${normalizedEmail}`);
    return;
  }

  const emailMatches = existing.email === normalizedEmail;
  const passwordMatches = verifyPasswordScrypt(password, existing.salt, existing.password_hash);

  if (emailMatches && passwordMatches) return; // já está tudo em dia

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  await run('UPDATE admins SET email = ?, password_hash = ?, salt = ? WHERE id = ?', [
    normalizedEmail,
    hash,
    salt,
    existing.id,
  ]);
  console.log(`[tn-zone] Administrador atualizado para: ${normalizedEmail}`);
}

// Limpeza best-effort de dados voláteis antigos (sessões expiradas e hits de
// rate limit velhos). Chamada com baixa probabilidade a cada request para não
// pesar todo request com um DELETE, mas ainda assim manter as tabelas enxutas
// sem precisar de um cron job dedicado.
async function pruneOldData() {
  try {
    await exec("DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL '1 day'");
    await exec("DELETE FROM rate_hits WHERE created_at < NOW() - INTERVAL '1 day'");
  } catch (err) {
    console.warn('[tn-zone] Falha ao limpar dados antigos (não crítico):', err.message);
  }
}

function init() {
  if (!initPromise) {
    initPromise = (async () => {
      await ensureSchema();
      await seed();
      await ensureAdmin();
    })().catch((err) => {
      initPromise = null; // permite tentar de novo na próxima invocação
      throw err;
    });
  }
  return initPromise;
}

module.exports = { pool, all, get, run, exec, tx, init, pruneOldData };

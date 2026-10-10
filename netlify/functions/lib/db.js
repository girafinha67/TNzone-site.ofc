'use strict';

const { Pool } = require('pg');
const crypto = require('node:crypto');

const rawDatabaseUrl = process.env.SUPABASE_DB_POOLER_URL || process.env.DATABASE_URL;

// O pooler do Supabase na porta 5432 é modo SESSÃO (limite de ~15 clientes, estoura fácil
// em serverless: EMAXCONNSESSION). Na porta 6543 (modo transação) não há esse problema, então
// trocamos automaticamente, a menos que DB_SCHEMA exija modo sessão (o SET vale por conexão).
function toTransactionPooler(url) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('.pooler.supabase.com') && u.port === '5432' && !process.env.DB_SCHEMA) {
      u.port = '6543';
      return u.toString();
    }
  } catch {
    // URL inválida: deixa o pg reportar o erro.
  }
  return url;
}
const databaseUrl = rawDatabaseUrl ? toTransactionPooler(rawDatabaseUrl) : rawDatabaseUrl;

if (!databaseUrl) {
  console.warn('[rshoes] SUPABASE_DB_POOLER_URL não definida — configure a connection string do Supabase nas env vars do Netlify.');
}

// max: em ambiente serverless (Netlify Functions) cada container "quente"
// mantém seu próprio Pool, e vários containers podem rodar em paralelo sob
// carga. O pooler do Supabase (PgBouncer) em modo "session" tem um limite
// baixo de clientes simultâneos (ex.: pool_size: 15 no plano free) — se cada
// container abrir muitas conexões, o total estoura esse limite e o Supabase
// devolve "(EMAXCONNSESSION) max clients reached in session mode". Por isso
// mantemos max baixo por container e liberamos conexões ociosas rápido.
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl && databaseUrl.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

// Isolamento opcional: com DB_SCHEMA definido, todas as tabelas desta loja ficam num
// schema próprio, sem tocar em tabelas de outro projeto que use o mesmo banco.
// Precisa de pooler em modo sessão (porta 5432), pois o SET vale por conexão.
const dbSchema = String(process.env.DB_SCHEMA || '').trim();
if (dbSchema) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbSchema)) {
    throw new Error('DB_SCHEMA inválido: use só letras, números e _.');
  }
  pool.on('connect', (client) => {
    client.query(`CREATE SCHEMA IF NOT EXISTS "${dbSchema}"`).catch((e) => console.error('[rshoes] CREATE SCHEMA falhou:', e.message));
    client.query(`SET search_path TO "${dbSchema}"`).catch((e) => console.error('[rshoes] SET search_path falhou:', e.message));
  });
}

pool.on('error', (err) => {
  // Erros em clients ociosos (ex.: conexão derrubada pelo pooler) não devem
  // derrubar o processo da function — só logamos.
  console.error('[rshoes] Erro inesperado no pool do Postgres:', err.message);
});

// Converte placeholders estilo "?" para o formato do Postgres ($1, $2...)
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

-- Sessão = também é o "dispositivo confiável": quando remember=1, dura 30 dias
-- e o navegador não precisa logar de novo. Revogar = apagar a linha (logout
-- "deste dispositivo" ou botão de revogar no painel).
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0,
  device_label TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
  brand TEXT NOT NULL DEFAULT '',
  sku TEXT,
  description TEXT,
  price REAL NOT NULL DEFAULT 0,
  promo_price REAL,
  sizes TEXT NOT NULL DEFAULT '[]',
  colors TEXT NOT NULL DEFAULT '[]',
  images TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  stock INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  merchant_charge_id TEXT UNIQUE NOT NULL,
  picpay_id TEXT,
  picpay_status TEXT,
  transaction_id TEXT,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  product_slug TEXT,
  product_image TEXT,
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  customer_name TEXT NOT NULL,
  customer_cpf TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  size TEXT,
  color TEXT,
  additional_data TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  pix_qr_code TEXT,
  pix_qr_code_base64 TEXT,
  pix_expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  whatsapp_notified_at TIMESTAMPTZ,
  error_message TEXT,
  stock_reserved INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_customer_email ON orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_orders_merchant_charge ON orders(merchant_charge_id);

-- Itens de um pedido de carrinho (multi-produto). Pedidos antigos / compra
-- direta de 1 produto continuam usando só as colunas product_* de orders e
-- não têm linhas aqui — o código trata os dois formatos.
CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  product_slug TEXT,
  product_image TEXT,
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  size TEXT,
  color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- Idempotência dos webhooks de pagamento: o mesmo evento pode ser reenviado.
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  merchant_charge_id TEXT NOT NULL,
  event_type TEXT,
  status TEXT,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_charge
  ON payment_webhook_events(merchant_charge_id);

-- Outbox de notificações: garante no máximo uma notificação lógica por pedido
-- e permite nova tentativa caso o WhatsApp esteja temporariamente indisponível.
CREATE TABLE IF NOT EXISTS payment_notifications (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(order_id, type)
);

CREATE INDEX IF NOT EXISTS idx_payment_notifications_pending
  ON payment_notifications(status, updated_at);

-- Feedbacks de clientes (foto/vídeo do pedido). Entram como 'pending' e só
-- aparecem no site depois que um admin aprova.
CREATE TABLE IF NOT EXISTS feedbacks (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  product_name TEXT NOT NULL,
  purchase_date DATE NOT NULL,
  media_url TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'image',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status, created_at DESC);

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

-- Registro de tentativas para rate limiting (login), persistido para
-- sobreviver a cold starts (diferente de um Map em memória).
CREATE TABLE IF NOT EXISTS rate_hits (
  id SERIAL PRIMARY KEY,
  bucket TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===================== Analytics (visitantes/sessões/eventos) =====================
-- Visitante anônimo: um UUID gerado e guardado no localStorage do navegador
-- (nunca dado pessoal). Serve só para diferenciar "novo" de "recorrente".
CREATE TABLE IF NOT EXISTS analytics_visitors (
  id TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sessions_count INTEGER NOT NULL DEFAULT 0
);

-- Sessão: UUID gerado no sessionStorage do navegador (expira sozinho ao
-- fechar a aba ou após 30min de inatividade — ver public/js/analytics-track.js).
-- Guarda o "resumo" da sessão; os eventos individuais ficam em analytics_events.
CREATE TABLE IF NOT EXISTS analytics_sessions (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL REFERENCES analytics_visitors(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_new_visitor INTEGER NOT NULL DEFAULT 0,
  entry_page TEXT,
  last_page TEXT,
  referrer TEXT,
  source TEXT,
  medium TEXT,
  campaign TEXT,
  term TEXT,
  content TEXT,
  device_type TEXT,
  browser TEXT,
  os TEXT,
  screen_w INTEGER,
  screen_h INTEGER,
  country TEXT,
  region TEXT,
  city TEXT,
  page_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0
);

-- Evento individual (page_view, product_view, whatsapp_click, search, etc).
-- Câmera lenta de tudo que acontece no site — as telas de Analytics leem
-- daqui via consultas agregadas (nunca varrendo a tabela inteira sem filtro
-- de data, ver lib/analytics-queries.js).
CREATE TABLE IF NOT EXISTS analytics_events (
  id BIGSERIAL PRIMARY KEY,
  event_name TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES analytics_sessions(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  page_url TEXT,
  page_path TEXT,
  referrer TEXT,
  product_id INTEGER,
  product_slug TEXT,
  category_slugs TEXT NOT NULL DEFAULT '[]',
  search_term TEXT,
  search_results INTEGER,
  meta TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
  `);

  // Categorias fixas (multi-seleção) do produto — ver lib/category-tags.js.
  // Coluna separada de category_id/categories (sistema antigo, mantido por
  // compatibilidade mas não usado mais no formulário de produto).
  await exec(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category_tags TEXT NOT NULL DEFAULT '[]';`);
  await exec(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS description TEXT;`);
  await exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_cart INTEGER NOT NULL DEFAULT 0;`);

  // PromissePay (PIX). Colunas aditivas: nada é removido, pedidos antigos (PicPay) seguem intactos.
  // Mesmo SQL em migrations/2026-10-10_promissepay.sql, para rodar manualmente no Supabase se preferir.
  await exec(`
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_provider TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promisse_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promisse_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promisse_fee INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promisse_checked_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_promisse_id ON orders(promisse_id) WHERE promisse_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_checkout_token ON orders(checkout_token) WHERE checkout_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_provider_status ON orders(payment_provider, status);
  `);

  await exec(`
CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_products_active_created ON products(active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
CREATE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug);
CREATE INDEX IF NOT EXISTS idx_categories_active_order ON categories(active, order_index);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_admin ON sessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rate_hits_lookup ON rate_hits(bucket, ip, created_at);

CREATE INDEX IF NOT EXISTS idx_analytics_visitors_last_seen ON analytics_visitors(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_started ON analytics_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_activity ON analytics_sessions(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_visitor ON analytics_sessions(visitor_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_name_created ON analytics_events(event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_visitor ON analytics_events(visitor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_product ON analytics_events(product_id, created_at DESC) WHERE product_id IS NOT NULL;
  `);
}

// Categorias reais da loja (mesmo conteúdo usado no preview estático do
// Spck Editor via mock-api.js) — semeadas de verdade no banco na primeira
// inicialização, para que a home mostre estas categorias também em produção
// (Netlify + Postgres), e não só no preview sem backend.
const REAL_CATEGORIES = [
  { name: 'Nike', slug: 'nike', image: '/assets/categories/nike.jpg', description: 'Cortes baixos para o dia a dia.', order_index: 1 },
  { name: 'Adidas', slug: 'adidas', image: '/assets/categories/adidas.jpg', description: 'Cano alto, presença de rua.', order_index: 2 },
  { name: 'New Balance', slug: 'new-balance', image: '/assets/categories/new-balance.jpg', description: 'Sem cadarço, praticidade total.', order_index: 3 },
  { name: 'Infantis', slug: 'infantis', image: '/assets/categories/infantis.jpg', description: 'Resistência para o street.', order_index: 4 },
  { name: 'Linha premium', slug: 'linha-premium', image: '/assets/categories/linha-premium.jpg', description: 'Peças exclusivas e numeradas.', order_index: 5 },
  { name: 'Vans', slug: 'vans', image: '/assets/categories/vans.jpg', description: 'Clássicos street e skate.', order_index: 6 },
];

async function seed() {
  const catCount = (await get('SELECT COUNT(*) AS n FROM categories')).n;
  if (Number(catCount) === 0) {
    const insertCat =
      'INSERT INTO categories (name, slug, image, description, order_index, active) VALUES (?, ?, ?, ?, ?, 1)';
    for (const c of REAL_CATEGORIES) {
      await run(insertCat, [c.name, c.slug, c.image, c.description, c.order_index]);
    }
  }
}

function verifyPasswordScrypt(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Garante que existe exatamente um administrador com as credenciais definidas
// em ADMIN_EMAIL / ADMIN_PASSWORD (variáveis de ambiente do Netlify). Nunca
// grava senha em texto puro — só hash scrypt + salt.
async function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn(
      '[rshoes] ADMIN_EMAIL/ADMIN_PASSWORD não definidos — configure-os nas ' +
      'variáveis de ambiente do Netlify para criar/atualizar o administrador.'
    );
    return;
  }
  const normalizedEmail = email.toLowerCase().trim();
  const existing = await get('SELECT * FROM admins ORDER BY id ASC LIMIT 1');

  if (!existing) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    await run('INSERT INTO admins (email, password_hash, salt) VALUES (?, ?, ?)', [
      normalizedEmail,
      hash,
      salt,
    ]);
    console.log(`[rshoes] Administrador inicial criado: ${normalizedEmail}`);
    return;
  }

  const emailMatches = existing.email === normalizedEmail;
  const passwordMatches = verifyPasswordScrypt(password, existing.salt, existing.password_hash);
  if (emailMatches && passwordMatches) return;

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  await run('UPDATE admins SET email = ?, password_hash = ?, salt = ? WHERE id = ?', [
    normalizedEmail,
    hash,
    salt,
    existing.id,
  ]);
  console.log(`[rshoes] Administrador atualizado para: ${normalizedEmail}`);
}

// Retenção do Analytics: por padrão guarda ~13 meses (permite comparar
// "este mês vs mesmo mês ano passado"). Ajustável via env var sem precisar
// alterar código. Ver README.md, seção de Analytics.
const ANALYTICS_RETENTION_DAYS = Math.max(
  30,
  parseInt(process.env.ANALYTICS_RETENTION_DAYS, 10) || 400
);

async function pruneOldData() {
  try {
    await exec("DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL '1 day'");
    await exec("DELETE FROM rate_hits WHERE created_at < NOW() - INTERVAL '1 day'");
    // Eventos/sessões/visitantes de Analytics mais antigos que a retenção
    // configurada. Eventos referenciam sessões com ON DELETE CASCADE, então
    // apagar a sessão já leva os eventos junto; visitantes só são removidos
    // quando não sobra nenhuma sessão recente (evita perder o "primeiro
    // acesso" de alguém que voltou a visitar recentemente).
    await exec(
      `DELETE FROM analytics_sessions WHERE started_at < NOW() - INTERVAL '${ANALYTICS_RETENTION_DAYS} days'`
    );
    await exec(
      `DELETE FROM analytics_visitors WHERE last_seen_at < NOW() - INTERVAL '${ANALYTICS_RETENTION_DAYS} days'`
    );
  } catch (err) {
    console.warn('[rshoes] Falha ao limpar dados antigos (não crítico):', err.message);
  }
}

// ---------- settings (key/value genérico — usado pelo toggle de Analytics) ----------
async function getSetting(key, fallback = null) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

function init() {
  if (!initPromise) {
    initPromise = (async () => {
      await ensureSchema();
      await seed();
      await ensureAdmin();
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

module.exports = { pool, all, get, run, exec, tx, init, pruneOldData, getSetting, setSetting, ANALYTICS_RETENTION_DAYS };

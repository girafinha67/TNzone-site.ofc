'use strict';

const express = require('express');
const serverless = require('serverless-http');

const db = require('./lib/db');
const { validateSession } = require('./lib/auth');
const { parseCookies } = require('./lib/http-utils');

const authRoutes = require('./routes/auth.routes');
const productRoutes = require('./routes/products.routes');
const categoryRoutes = require('./routes/categories.routes');
const feedbackRoutes = require('./routes/feedbacks.routes');
const settingsRoutes = require('./routes/settings.routes');
const dashboardRoutes = require('./routes/dashboard.routes');

const app = express();

app.use(express.json({ limit: '15mb' }));

// Garante schema/seed/admin inicial antes de qualquer rota (memoizado por container).
app.use(async (req, res, next) => {
  try {
    await db.init();
    if (Math.random() < 0.02) db.pruneOldData(); // best-effort, não bloqueia a request
    next();
  } catch (err) {
    console.error('[tn-zone] Falha ao inicializar banco de dados:', err);
    res.status(500).json({ error: 'Erro ao conectar ao banco de dados. Verifique SUPABASE_DB_POOLER_URL.' });
  }
});

// Sessão: lê cookie, valida, e disponibiliza req.admin/req.cookies em toda rota.
app.use(async (req, res, next) => {
  try {
    req.cookies = parseCookies(req);
    const session = await validateSession(req.cookies.tnz_session);
    req.admin = session ? session.admin : null;
    next();
  } catch (err) {
    next(err);
  }
});

// Bloqueia rotas /admin/* para quem não tem sessão válida.
const requireAuth = (req, res, next) => {
  if (!req.admin) return res.status(401).json({ error: 'Não autenticado. Faça login novamente.' });
  next();
};

const apiRouter = express.Router();
apiRouter.use('/admin', requireAuth);
apiRouter.use(authRoutes);
apiRouter.use(productRoutes);
apiRouter.use(categoryRoutes);
apiRouter.use(feedbackRoutes);
apiRouter.use(settingsRoutes);
apiRouter.use(dashboardRoutes);
apiRouter.use((req, res) => {
  res.status(404).json({ error: 'Rota de API não encontrada.' });
});

// O redirect do netlify.toml manda /api/* para esta function. Dependendo de
// como o runtime normaliza o path, o Express pode ver "/api/produtos" ou já
// "/produtos" (prefixo já removido). Montamos nos dois lugares para cobrir
// os dois comportamentos sem risco de colisão (só um vai bater de fato).
app.use('/api', apiRouter);
app.use(apiRouter);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Erro interno do servidor.' });
});

module.exports.handler = serverless(app);

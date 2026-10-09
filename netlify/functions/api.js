'use strict';

const express = require('express');
const serverless = require('serverless-http');

const db = require('./lib/db');
const { validateSession, COOKIE_NAME } = require('./lib/auth');
const { parseCookies } = require('./lib/http-utils');

const authRoutes = require('./routes/auth.routes');
const productRoutes = require('./routes/products.routes');
const categoryRoutes = require('./routes/categories.routes');
const uploadRoutes = require('./routes/uploads.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const trackRoutes = require('./routes/track.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const orderRoutes = require('./routes/orders.routes');
const settingsRoutes = require('./routes/settings.routes');
const feedbackRoutes = require('./routes/feedbacks.routes');

const app = express();

app.use(express.json({ limit: '15mb' }));

// Garante schema/seed/admin inicial antes de qualquer rota (memoizado por container).
app.use(async (req, res, next) => {
  try {
    await db.init();
    if (Math.random() < 0.02) db.pruneOldData(); // best-effort, não bloqueia a request
    next();
  } catch (err) {
    console.error('[rshoes] Falha ao inicializar banco de dados:', err);
    res.status(500).json({ error: 'Erro ao conectar ao banco de dados. Verifique SUPABASE_DB_POOLER_URL.' });
  }
});

// Sessão: lê cookie, valida, e disponibiliza req.admin/req.cookies em toda rota.
app.use(async (req, res, next) => {
  try {
    req.cookies = parseCookies(req);
    const session = await validateSession(req.cookies[COOKIE_NAME]);
    req.admin = session ? session.admin : null;
    next();
  } catch (err) {
    next(err);
  }
});

// Bloqueia TODAS as rotas /admin/* (produtos, categorias, uploads, dashboard,
// devices) para quem não tem sessão válida. Nunca confie só no frontend: o
// admin.html só esconde botões, quem realmente barra é este middleware.
const requireAuth = (req, res, next) => {
  if (!req.admin) return res.status(401).json({ error: 'Não autenticado. Faça login novamente.' });
  next();
};

const apiRouter = express.Router();
apiRouter.use('/admin', requireAuth);
apiRouter.use(authRoutes);
apiRouter.use(productRoutes);
apiRouter.use(categoryRoutes);
apiRouter.use(uploadRoutes);
apiRouter.use(dashboardRoutes);
apiRouter.use(orderRoutes); // checkout, Pix e webhook público
apiRouter.use(settingsRoutes); // conteúdo editável da home (topbar, hero, benefícios, banner)
apiRouter.use(feedbackRoutes); // feedbacks de clientes: envio público + moderação em /admin/feedbacks
apiRouter.use(trackRoutes); // POST /track — público, evento de Analytics do visitante
apiRouter.use(analyticsRoutes); // /admin/analytics/* — protegido pelo requireAuth acima
apiRouter.use((req, res) => {
  res.status(404).json({ error: 'Rota de API não encontrada.' });
});

// O redirect do netlify.toml manda /api/* para esta function. Montamos nos
// dois prefixos possíveis para cobrir como o runtime normaliza o path.
app.use('/api', apiRouter);
app.use(apiRouter);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Erro interno do servidor.' });
});

module.exports.handler = serverless(app);

# TN Zone — Loja virtual de tênis e streetwear (versão Netlify)

Catálogo de tênis, camisas e calças com compra via WhatsApp e painel
administrativo completo (produtos, categorias, página inicial, feedbacks
moderados, configurações gerais).

Esta é a versão **adaptada para rodar no Netlify**. A versão original (Node
puro + SQLite em arquivo + uploads em disco + SSE) não funciona em Netlify
porque Functions são serverless e stateless — sem processo persistente, sem
disco durável e sem conexões longas. Trocamos:

| Original                          | Versão Netlify                                   |
|------------------------------------|---------------------------------------------------|
| Servidor HTTP próprio (`.listen`)  | Netlify Function única (Express + `serverless-http`), acionada via redirect `/api/*` |
| SQLite em arquivo (`node:sqlite`)  | Postgres externo (`pg`) — ex. Neon, Supabase, Railway |
| Upload salvo em `uploads/` no disco| Cloudinary (upload assinado, URL pública direta)  |
| Server-Sent Events (`/api/events`) | Polling simples no frontend (15s) — ver `public/js/api.js` |
| Frontend servido pelo mesmo processo| Frontend estático servido direto pela CDN do Netlify (`public/`) |

## Estrutura do projeto

```
netlify.toml                 # redirect /api/* -> function, publish dir
package.json
netlify/functions/
  api.js                      # Express app + serverless-http (handler único)
  lib/
    db.js                      # pool Postgres + schema + seed
    auth.js                    # sessão, hash de senha, rate limit, log
    http-utils.js               # cookies, slugify, wrapper async
    upload.js                    # upload/exclusão assinados no Cloudinary
    realtime.js                   # no-op (SSE não existe em serverless)
  routes/
    auth.routes.js, products.routes.js, categories.routes.js,
    feedbacks.routes.js, settings.routes.js, dashboard.routes.js
public/                       # frontend (site + admin) — publicado como estático
  css/, js/, admin/, index.html, catalogo.html, produto.html, feedbacks.html
.env.example
```

## Deploy no Netlify — passo a passo

### 1. Supabase (banco + imagens)

Crie um projeto em [supabase.com](https://supabase.com). Em
`Project Settings → Database → Connection string`, copie a URI do
**Session Pooler** e configure `SUPABASE_DB_POOLER_URL`.

Em `Storage → New bucket`, crie um bucket público chamado `tnzone-images`.
Use limite de 8 MB e permita PNG, JPG, JPEG, WEBP e GIF.

Em `Project Settings → API`, configure `SUPABASE_URL` e a
`SUPABASE_SERVICE_ROLE_KEY` nas variáveis privadas do Netlify. A service role
key nunca deve ir para o frontend ou ser commitada no GitHub.

### 3. Configurar o site no Netlify

1. Suba este projeto num repositório Git (GitHub/GitLab/Bitbucket) e conecte
   no Netlify (**Add new site → Import an existing project**), ou use
   `netlify deploy` via CLI.
2. Build settings já vêm do `netlify.toml` (publish = `public`, functions =
   `netlify/functions`). Não precisa mudar nada no painel.
3. Em **Site configuration → Environment variables**, adicione:
   - `NODE_ENV=production`
   - `SUPABASE_DB_POOLER_URL`, `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`
   - `ADMIN_EMAIL` e `ADMIN_PASSWORD` (credenciais do primeiro admin — troque
     a senha padrão!)
4. Deploy. Na primeira requisição que acionar a function (`/api/...`), o
   banco cria as tabelas automaticamente e o primeiro admin é criado a partir
   de `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

### 4. Acessar

- Site: `https://SEU-SITE.netlify.app`
- Painel admin: `https://SEU-SITE.netlify.app/admin/login`

Depois do primeiro login, troque a senha pelo próprio painel
(Configurações → Alterar senha) e remova `ADMIN_EMAIL`/`ADMIN_PASSWORD` das
env vars do Netlify (elas só são lidas quando não existe nenhum admin ainda).

## Rodando localmente (opcional, para testar antes do deploy)

Requer Node 18+ e a CLI do Netlify (`npm install -g netlify-cli`).

```bash
npm install
cp .env.example .env   # preencha as variáveis privadas do Supabase e ADMIN_*
netlify dev
```

Isso sobe o site estático + a Function localmente em `http://localhost:8888`,
já com o redirect `/api/*` funcionando como em produção.

## Configurando o WhatsApp

Em **Admin → Configurações**, informe o número no campo "Número de
WhatsApp" apenas com dígitos, incluindo DDI e DDD (ex: `5561986553995`
para +55 61 98655-3995). A mensagem é montada automaticamente com saudação
conforme o horário e frase adaptada ao tipo do produto.

## Limitações conhecidas desta versão

- **Rate limiting de login** é em memória por instância de function — em
  cold start o contador zera. Para algo mais rígido, migre para uma tabela
  dedicada no Postgres.
- **Exclusão de imagens no Supabase Storage** é best-effort (não bloqueia a
  operação se falhar) — pode deixar arquivos órfãos ocasionalmente.
- **Tempo real** agora é polling (a cada 15s), não é instantâneo como o SSE
  original — trade-off necessário em ambiente serverless.
- O `data/` e `uploads/` da versão original não existem mais nesta versão
  (substituídos por Supabase Postgres + Supabase Storage).

## Segurança já implementada

- Senhas com hash `scrypt` + salt individual (nunca texto puro)
- Sessão via cookie `HttpOnly`, `SameSite=Lax`, `Secure` em produção
- Token de sessão nunca fica gravado em texto puro no banco (só o hash)
- Rate limiting de tentativas de login por IP (ver limitação acima)
- Validação de tipo/tamanho em uploads de imagem
- Todas as rotas administrativas exigem sessão válida checada no servidor
- Log de ações administrativas (login, criação/edição/exclusão, moderação de
  feedback, alteração de configurações)
- Sanitização de saída (`escapeHtml`) em todo texto vindo do usuário antes de
  ir para o HTML, evitando XSS

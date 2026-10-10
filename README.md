# TN'zone — site + painel administrativo

Landing page e catálogo da TN'zone (São Luís — MA), com painel de
administração para cadastrar produtos de verdade (sem produtos fictícios
no código). Backend em Node/Express rodando como Netlify Function, com
Postgres (Supabase) como banco de dados.

## Estrutura

```
public/
  index.html          → home (busca produtos em /api/products)
  catalogo.html        → catálogo completo, com filtro por categoria
  admin/                → painel administrativo (login, produtos, categorias, analytics)
  js/, css/, assets/    → scripts e estilos do site e do admin
netlify/
  functions/api.js      → função serverless única que expõe toda a API em /api/*
  functions/lib/         → banco de dados, autenticação, upload de imagens, analytics
  functions/routes/      → rotas (produtos, categorias, auth, uploads, analytics)
netlify.toml
package.json
```

O design da home e do catálogo (preto e branco, tipografia Space Grotesk/Inter)
não foi alterado — só a origem dos produtos, que agora vem do banco em vez de
estar fixa no HTML.

## 1. Banco de dados (Supabase)

1. Crie um projeto gratuito em https://supabase.com.
2. Em **Project Settings → Database**, copie a "Connection string" no modo
   *Connection pooling* (porta 6543). Essa é a variável `SUPABASE_DB_POOLER_URL`.
3. Em **Project Settings → API**, copie a `Project URL` (→ `SUPABASE_URL`) e a
   `service_role` key (→ `SUPABASE_SERVICE_ROLE_KEY`) — usada só pelo backend
   para o upload de imagens.
4. Em **Storage**, crie um bucket público chamado `rshoes-images`.

O schema (tabelas de produtos, categorias, admins, sessões, analytics) é
criado sozinho na primeira requisição — não é preciso rodar nenhum SQL manual.

## 2. Variáveis de ambiente (Netlify → Site settings → Environment variables)

| Variável | Para quê |
|---|---|
| `SUPABASE_DB_POOLER_URL` | conexão do backend com o Postgres |
| `SUPABASE_URL` | URL do projeto Supabase (upload de imagens) |
| `SUPABASE_SERVICE_ROLE_KEY` | chave de serviço do Supabase (upload de imagens) |
| `ADMIN_EMAIL` | e-mail do administrador do painel |
| `ADMIN_PASSWORD` | senha do administrador do painel |

O admin é criado/atualizado automaticamente a partir de `ADMIN_EMAIL` /
`ADMIN_PASSWORD` — não existe usuário nem senha padrão no código.

## 3. Deploy

1. Suba esta pasta para um repositório Git (GitHub/GitLab) ou arraste o
   projeto direto no Netlify (Sites → "Add new site" → "Deploy manually").
2. Configure as variáveis de ambiente acima.
3. O `netlify.toml` já define o build (`npm install`), a pasta publicada
   (`public`) e o redirecionamento de `/api/*` para a function.

Depois do deploy:

- Site: `https://SEU-SITE.netlify.app/`
- Catálogo: `https://SEU-SITE.netlify.app/catalogo.html`
- Painel admin: `https://SEU-SITE.netlify.app/admin/` (faça login com
  `ADMIN_EMAIL` / `ADMIN_PASSWORD`)

## 4. Cadastrando produtos

No painel (`/admin/produtos.html`) você cadastra nome, preço, preço
promocional, estoque, imagens e categorias (Low, High, Slip-on, Skate,
Edição Limitada, Acessórios). Assim que um produto é salvo como ativo, ele
aparece automaticamente:

- na home, na seção "Latest Drops" (6 mais recentes);
- na home, na seção de destaque, se marcado como **featured**;
- no catálogo completo, já filtrável por categoria.

Não há nenhum produto de exemplo no código — o site começa vazio até você
cadastrar o primeiro produto pelo painel.

## 5. Rodando localmente (opcional)

```bash
npm install -g netlify-cli
npm install
netlify dev
```

O `netlify dev` sobe o site e as functions juntos em `http://localhost:8888`,
usando as mesmas variáveis de ambiente (pode criar um arquivo `.env` local).

## 6. Pagamento PIX real via PromissePay + WhatsApp

Documentação oficial: https://promisse.com.br/docs (base `https://api.promisse.com.br`).

### Fluxo

```text
Cliente escolhe produto/carrinho e preenche os dados  (/checkout.html)
  ↓  POST /api/payments/pix/create  (ou /create-cart)  — preço lido do BANCO, nunca do navegador
Pedido PENDING + estoque reservado + checkout_token (idempotência)
  ↓  POST https://api.promisse.com.br/transactions  { amount } — só pelo backend, chave no servidor
Cobrança real: id, copyPaste, qrCodeBase64, expiresAt  →  gravados no pedido (orders.promisse_id)
  ↓
Checkout exibe QR Code + copia-e-cola + contagem regressiva (dados vindos do gateway)
  ↓  cliente paga
PromissePay → POST /.netlify/functions/promissepay-webhook   (evento payment.approved)
  ↓  valida promisse-signature = sha256=HMAC-SHA256(corpo BRUTO, secret)  — senão 401
  ↓  localiza o pedido pelo id da transação  — desconhecida → 404
  ↓  confirma na API: GET /transactions/:id  (status PAID, tipo DEPOSIT, valor == pedido)
  ↓  transação PostgreSQL + FOR UPDATE + registro do evento (idempotência)
PENDING → PAID  →  notificação WhatsApp (outbox)
```

O navegador **só consulta** `GET /api/payments/orders/:id`. Nenhum parâmetro de URL, status enviado
pelo cliente ou visita à página de sucesso marca um pedido como pago. Se o pedido ainda está pendente,
essa rota reconfirma na API da PromissePay (no máximo 1 consulta a cada 10 s por pedido).

### Garantias implementadas

- **Idempotência da criação**: a API da PromissePay não documenta chave de idempotência, então o controle é
  nosso: o navegador manda um `checkoutToken` único por tentativa (`orders.checkout_token`, índice único).
  Reenvio/duplo clique devolve o mesmo pedido, sem nova cobrança. O POST **nunca** é repetido automaticamente.
- **Idempotência do webhook**: chave `promisse:<evento>:<data.id>` em `payment_webhook_events.event_id` (UNIQUE).
  Entrega duplicada → 200 sem alterar nada.
- **Valor**: pago só se `amount` (centavos) da API == valor do pedido. Divergência → 409, pedido segue pendente.
- **Isolamento**: o pedido é sempre achado pelo `id` da transação (`orders.promisse_id`, único).
- **Falha na criação / timeout (8 s)**: pedido vira `ERROR` e o estoque volta.
- **Pedido órfão** (cobrança criada mas não vinculada): encerrado pela reconciliação em 15 min.
- **Reconciliação** a cada 10 min (`reconcile-payments`): reconsulta pedidos `PENDING`, marca `EXPIRED` os vencidos.
- Segredos nunca vão para o navegador nem para os logs.

### Estados do pedido

`PENDING` (aguardando) · `PAID` (aprovado) · `EXPIRED` (PIX vencido, definido localmente a partir do `expiresAt`) ·
`FAILED` (evento `payment.failed`: recusada ou expirada) · `ERROR` (falha ao criar a cobrança).

### Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `PROMISSEPAY_API_KEY` | chave `sk_live_...` (Painel PromissePay → Integrações → Credenciais). Escopos mínimos: `payments.create` e `payments.read` |
| `PROMISSEPAY_WEBHOOK_SECRET` | secret do webhook, mostrada ao cadastrá-lo (valida a assinatura HMAC) |
| `PROMISSEPAY_BASE_URL` | opcional; padrão `https://api.promisse.com.br` (HTTPS obrigatório) |
| `PROMISSEPAY_TIMEOUT_MS` | opcional; padrão `8000` |

### Webhook

URL: `https://tnzone-site-loja.netlify.app/.netlify/functions/promissepay-webhook`
(arquivo `netlify/functions/promissepay-webhook.js`). Evento a assinar: `payment.approved`
(e `payment.failed` para encerrar pedidos recusados/expirados).

### Variáveis de ambiente — WhatsApp

O código usa um endpoint compatível com o formato de envio de texto da WhatsApp Cloud API/Meta:

| Variável | Descrição |
|---|---|
| `WHATSAPP_API_URL` | URL completa do endpoint de envio de mensagens |
| `WHATSAPP_TOKEN` | token Bearer da API |
| `WHATSAPP_OWNER_PHONE` | número do dono que receberá a notificação, com DDI |

**Importante:** chaves, secrets e tokens não devem ser colocados em HTML/JavaScript público nem enviados para o navegador.

### Publicar e ativar (passo a passo)

1. Netlify → Site configuration → Environment variables: cadastre `PROMISSEPAY_API_KEY` e `PROMISSEPAY_WEBHOOK_SECRET`
   (o secret só existe depois do passo 3; cadastre a chave agora e o secret logo em seguida).
2. Publique o projeto (o primeiro request aplica as colunas novas sozinho; o SQL equivalente está em
   `migrations/2026-10-10_promissepay.sql`).
3. Painel PromissePay → Integrações → Webhooks: URL `https://tnzone-site-loja.netlify.app/.netlify/functions/promissepay-webhook`,
   eventos `payment.approved` e `payment.failed`. Copie a secret **exatamente como exibida** para `PROMISSEPAY_WEBHOOK_SECRET`
   e faça novo deploy. (O cadastro envia `{"event":"webhook.test"}` e exige 200/201/202 — a função responde 200.)
4. **Não** restrinja a chave por IP: as Netlify Functions não têm IP fixo.
5. Teste real com o menor valor possível (R$ 0,50): gere o PIX, pague, confira `PAID` no pedido e nos logs da função.

### Testes automatizados

```bash
npm test
```

Usam fakes (identificados nos arquivos de teste) para o gateway e o banco; não fazem chamadas reais.
Eles NÃO substituem um teste real ponta a ponta com uma cobrança de valor mínimo (R$ 0,50).

## Feedbacks de clientes

- Seção "Quem comprou, aprovou" na home (entre os benefícios e o "Sobre"). O cliente envia foto ou vídeo com nome completo, produto e data da compra.
- O arquivo vai direto do navegador para o Supabase Storage (URL assinada gerada em `POST /api/feedbacks/upload-url`), no bucket público `rshoes-feedbacks`, criado automaticamente no primeiro envio. Precisa de `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`.
- Limites: foto até 8 MB, vídeo até 50 MB (o plano do Supabase também precisa permitir esse tamanho).
- Todo envio entra como `pending`. A moderação fica em `/admin/feedbacks.html` (aprovar, rejeitar, excluir). No site aparece só "Nome S.", o nome completo fica apenas no painel.
- A tabela `feedbacks` é criada sozinha no `db.init()`.

## Banco compartilhado com outro projeto (DB_SCHEMA)

Se o Supabase já tiver tabelas de outro site (ex.: `products` sem a coluna `brand`), defina `DB_SCHEMA=tnzone_loja` no Netlify. Todas as tabelas desta loja passam a ser criadas nesse schema, sem mexer nas do outro projeto. Requer o pooler na porta 5432 (modo sessão). Sem `DB_SCHEMA`, as tabelas ficam em `public`.


## 7. Painel admin no celular

O painel (`/admin/*`) é responsivo (`public/css/admin-mobile.css` + `public/js/admin-common.js`):

- até 860px: o menu lateral vira uma gaveta aberta pelo botão ☰ na barra do topo;
- até 640px: as tabelas viram cards (o rótulo de cada campo vem do `<th>`), os
  formulários abrem como *bottom sheet* com o botão Salvar fixo embaixo, e os
  campos usam fonte de 16px para o iOS não dar zoom ao digitar;
- acima de 860px o layout de desktop continua igual.

## 8. Categorias: como o catálogo encontra o produto

O formulário de produto grava a categoria em `products.category_tags`
(slugs `low`, `high`, `slip-on`, `skate`, `edicao-limitada`, `vans`), enquanto os
filtros do catálogo e os cards da home usam os slugs da tabela `categories`
(`nike`, `adidas`, `new-balance`, `infantis`, `linha-premium`, `vans`).
`CATEGORY_SLUG_TO_TAG` em `netlify/functions/lib/category-tags.js` liga os dois, e
`GET /api/products?category=...` procura por `category_id` **ou** pela tag. Se
você criar uma categoria nova, adicione o par nesse mapa e em `category-tags.js`
(front e back).

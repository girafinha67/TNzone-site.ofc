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

## 6. Pagamento real via PicPay + WhatsApp

O projeto agora possui checkout Pix real em `/checkout.html?produto=SLUG`.

Fluxo:

1. O cliente escolhe o produto e a quantidade.
2. Informa nome completo, CPF, e-mail, telefone, tamanho/cor e dados adicionais.
3. O backend calcula o preço diretamente do produto no banco e cria uma cobrança Pix no PicPay.
4. A página exibe o QR Code e o Pix Copia e Cola.
5. O navegador apenas consulta o pedido; **não confirma pagamento por conta própria**.
6. O PicPay chama `POST /api/payments/picpay/webhook`.
7. O webhook valida o `Authorization` recebido do PicPay, marca o pedido como `PAID`, registra horário/transactionId, libera/baixa estoque conforme o fluxo e calcula a pontuação.
8. Após o pagamento confirmado, o sistema envia automaticamente os dados do pedido para o WhatsApp configurado.

A API Pix do PicPay usa OAuth 2.0 `client_credentials`. As credenciais ficam somente no backend. O token de acesso é temporário; o backend faz cache/renovação automática. Consulte a documentação oficial do PicPay antes de colocar em produção:
https://developers-business.picpay.com/pix/docs/authentication

### Variáveis de ambiente — PicPay

Configure no Netlify:

| Variável | Exemplo/descrição |
|---|---|
| `PICPAY_ENV` | `production` ou `sandbox` |
| `PICPAY_CLIENT_ID` | client_id gerado no Painel Lojista |
| `PICPAY_CLIENT_SECRET` | client_secret do PicPay |
| `PICPAY_WEBHOOK_TOKEN` | token exibido pelo PicPay ao configurar a URL de notificação |
| `PICPAY_CALLER_ORIGIN` | opcional, identificação da integração |
| `PICPAY_PIX_EXPIRATION_SECONDS` | opcional; padrão `900` |
| `PICPAY_COUNTRY_CODE` | opcional; padrão `55` |
| `POINTS_PER_REAL` | opcional; padrão `1` ponto por R$ 1,00 |

Produção usa `https://ecommerce-api.svcp.picpay.com`; homologação usa `https://ecommerce-api.svcp.ppay.me`.

### URL do webhook no PicPay

Depois do deploy, informe no Painel Lojista a URL:

`https://SEU-DOMINIO/api/payments/picpay/webhook`

A URL precisa ser HTTPS e o PicPay envia o token de autenticação no header `Authorization`. Não coloque query parameters nessa URL.

### Variáveis de ambiente — WhatsApp

O código usa um endpoint compatível com o formato de envio de texto da WhatsApp Cloud API/Meta:

| Variável | Descrição |
|---|---|
| `WHATSAPP_API_URL` | URL completa do endpoint de envio de mensagens |
| `WHATSAPP_TOKEN` | token Bearer da API |
| `WHATSAPP_OWNER_PHONE` | número do dono que receberá a notificação, com DDI |

A mensagem enviada contém: número do pedido, produto, quantidade, pontuação, valor, nome, CPF, e-mail, telefone, tamanho/cor, dados adicionais, status de pagamento, horário e identificador da cobrança PicPay.

**Importante:** tokens, `client_secret` e credenciais não devem ser colocados em HTML/JavaScript público nem enviados para o navegador.

### Teste antes de produção

Recomenda-se configurar primeiro `PICPAY_ENV=sandbox`, testar criação da cobrança e o webhook, e só depois trocar para `production`.

O PicPay documenta a API Pix, os estados de cobrança e o webhook no portal oficial:
https://developers-business.picpay.com/pix/docs/introduction
https://developers-business.picpay.com/pix/docs/webhook


## Pagamentos PicPay — produção e idempotência

O checkout usa a API Pix do PicPay no backend. O navegador nunca decide que um pagamento foi recebido.

### Webhook

Endpoint:

`POST /api/payments/picpay/webhook`

No Painel Lojista do PicPay, configure a URL HTTPS acima. O PicPay envia o token no header `Authorization` e o header `event_type` com `TransactionUpdateMessage`. O código valida os dois antes de processar o evento.

O webhook também exige `type=PAYMENT`, `id` do evento e `data.merchantChargeId`. O pedido é localizado pelo `merchant_charge_id` e atualizado dentro de uma transação PostgreSQL com `SELECT ... FOR UPDATE`.

### Proteções de produção

- `payment_webhook_events.event_id UNIQUE` impede processar o mesmo evento duas vezes.
- `orders.merchant_charge_id UNIQUE` garante uma cobrança externa por pedido.
- `FOR UPDATE` serializa atualizações concorrentes do mesmo pedido.
- `PAID` só é aceito quando o pagamento é PIX e o valor recebido em centavos coincide com o valor do pedido.
- O estoque só é devolvido uma vez, enquanto `stock_reserved=1`.
- A notificação de WhatsApp usa uma outbox (`payment_notifications`) com `UNIQUE(order_id, type)`, permitindo nova tentativa sem duplicar a notificação lógica.
- O WhatsApp fica fora da transação de pagamento. Se o WhatsApp falhar, o pedido continua `PAID`.
- Existe reconciliação automática a cada 10 minutos para pedidos `PENDING` com mais de 2 minutos, consultando diretamente `GET /charge/:merchantChargeId` no PicPay.
- Também existe reconciliação manual para administrador:
  `POST /api/admin/payments/picpay/reconcile/:merchantChargeId`

### Variáveis obrigatórias

```env
PICPAY_ENV=production
PICPAY_CLIENT_ID=
PICPAY_CLIENT_SECRET=
PICPAY_WEBHOOK_TOKEN=
PICPAY_CALLER_ORIGIN=TN'zone
PICPAY_PIX_EXPIRATION_SECONDS=900
PICPAY_COUNTRY_CODE=55

POINTS_PER_REAL=1

WHATSAPP_API_URL=
WHATSAPP_TOKEN=
WHATSAPP_OWNER_PHONE=
TZ=America/Fortaleza
```

Nunca coloque `PICPAY_CLIENT_SECRET`, `PICPAY_WEBHOOK_TOKEN` ou `WHATSAPP_TOKEN` no frontend.

### Fluxo de confirmação

```text
Cliente
  ↓
Checkout
  ↓
Pedido PENDING + estoque reservado
  ↓
PicPay gera cobrança PIX
  ↓
Cliente paga
  ↓
PicPay → webhook
  ↓
valida Authorization + event_type + type + event id
  ↓
transação PostgreSQL + FOR UPDATE
  ↓
valida merchantChargeId + PIX + valor
  ↓
PENDING → PAID
  ↓
cria notificação WhatsApp PENDING
  ↓
COMMIT
  ↓
envia WhatsApp
  ↓
SENT
```

O PicPay documenta o webhook como uma notificação a cada mudança de status e também disponibiliza a consulta de uma charge pelo `merchantChargeId`, usada pelo reconciliador deste projeto.

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

# TN Zone

Site da TN Zone, uma loja virtual de tênis e streetwear com catálogo público, páginas institucionais, feedbacks e painel administrativo.

## Run & Operate

- O conteúdo público está em `public/`.
- As funções de backend Netlify estão em `netlify/functions/`.
- O projeto usa as configurações de `netlify.toml` para publicação.
- O arquivo `.env.example` lista as variáveis necessárias sem conter valores secretos.

## Stack

- Páginas HTML, CSS e JavaScript em `public/`
- Funções Netlify em Node.js
- PostgreSQL/Supabase para dados, conforme configuração das funções
- Componentes auxiliares em `components/` e `lib/`

## Product

- Catálogo de produtos e páginas de detalhe
- Página inicial, contato, sobre e feedbacks
- Área administrativa para produtos, categorias, configurações, dashboard e feedbacks

## User preferences

- Responder em português.
- Nunca solicitar ou exibir tokens e credenciais no chat; usar o fluxo seguro de Secrets quando necessário.

## Gotchas

- Não commitar `.env` ou valores secretos; use `.env.example` como referência.
- Alterações em funções, banco ou variáveis de ambiente devem ser verificadas junto com a configuração de Netlify.
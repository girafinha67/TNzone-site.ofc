-- PromissePay (PIX) — migração aditiva e idempotente (pode ser executada mais de uma vez).
-- O app já aplica isto sozinho no primeiro request (db.init). Use este arquivo só se preferir
-- rodar manualmente no SQL Editor do Supabase. Não altera nem apaga dados existentes.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_provider TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promisse_id TEXT;            -- id da cobrança na PromissePay
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promisse_status TEXT;        -- último status bruto visto no gateway
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promisse_fee INTEGER;        -- taxa (centavos) informada na criação
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promisse_checked_at TIMESTAMPTZ;  -- throttle da consulta ao gateway
ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_token TEXT;         -- idempotência do checkout (reenvio/duplo clique)

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_promisse_id ON orders(promisse_id) WHERE promisse_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_checkout_token ON orders(checkout_token) WHERE checkout_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_provider_status ON orders(payment_provider, status);

-- Reaproveitadas sem alteração: orders (pedido, itens, dados de entrega, valor, status, datas, QR/copia-e-cola),
-- payment_webhook_events (idempotência: event_id UNIQUE) e payment_notifications (outbox do WhatsApp).

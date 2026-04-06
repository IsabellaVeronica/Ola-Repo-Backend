BEGIN;

CREATE TABLE IF NOT EXISTS public.configuracion (
  clave TEXT PRIMARY KEY,
  valor JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.auditoria (
  id BIGSERIAL PRIMARY KEY,
  actor_id INTEGER,
  target_usuario_id INTEGER,
  target_pedido_id INTEGER,
  target_tipo TEXT,
  action TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_auditoria_actor
    FOREIGN KEY (actor_id) REFERENCES public.usuario (id_usuario)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_auditoria_target_usuario
    FOREIGN KEY (target_usuario_id) REFERENCES public.usuario (id_usuario)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_auditoria_target_pedido
    FOREIGN KEY (target_pedido_id) REFERENCES public.pedido (id_pedido)
    ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_auditoria_created_at
  ON public.auditoria (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auditoria_action
  ON public.auditoria (action);

CREATE INDEX IF NOT EXISTS idx_auditoria_target_tipo
  ON public.auditoria (target_tipo);

CREATE INDEX IF NOT EXISTS idx_auditoria_actor
  ON public.auditoria (actor_id);

CREATE INDEX IF NOT EXISTS idx_auditoria_target_usuario
  ON public.auditoria (target_usuario_id);

CREATE INDEX IF NOT EXISTS idx_auditoria_target_pedido
  ON public.auditoria (target_pedido_id);

INSERT INTO public.configuracion (clave, valor, updated_at)
VALUES
  ('tienda', '{"abierto": true, "icono_url": null}'::jsonb, NOW()),
  ('catalogo', '{"ocultar_sin_stock": false}'::jsonb, NOW()),
  ('whatsapp', '{"numero":"584129326373","mensaje_bienvenida":"Hola, me interesa este producto de Banano Shop."}'::jsonb, NOW())
ON CONFLICT (clave) DO NOTHING;

COMMIT;

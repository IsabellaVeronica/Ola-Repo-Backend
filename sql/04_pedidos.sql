BEGIN;

CREATE TABLE IF NOT EXISTS public.cliente (
  cedula TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  telefono TEXT,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cliente_telefono
  ON public.cliente (telefono)
  WHERE telefono IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cliente_email_lower
  ON public.cliente ((LOWER(email)))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.pedido (
  id_pedido SERIAL PRIMARY KEY,
  cedula_cliente TEXT NOT NULL,
  origen TEXT NOT NULL DEFAULT 'web',
  cliente_nombre TEXT NOT NULL,
  cliente_email TEXT NOT NULL,
  cliente_telefono TEXT NOT NULL,
  observacion TEXT,
  estado TEXT NOT NULL DEFAULT 'nuevo',
  total_estimado NUMERIC(12, 2) NOT NULL DEFAULT 0,
  whatsapp_text TEXT,
  whatsapp_link TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_pedido_cliente
    FOREIGN KEY (cedula_cliente) REFERENCES public.cliente (cedula)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT ck_pedido_estado
    CHECK (estado IN ('nuevo', 'contactado', 'concretado', 'cancelado')),
  CONSTRAINT ck_pedido_total_estimado
    CHECK (total_estimado >= 0)
);

CREATE INDEX IF NOT EXISTS idx_pedido_created_at
  ON public.pedido (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pedido_estado
  ON public.pedido (estado);

CREATE INDEX IF NOT EXISTS idx_pedido_cedula_cliente
  ON public.pedido (cedula_cliente);

CREATE TABLE IF NOT EXISTS public.pedido_item (
  id_pedido_item SERIAL PRIMARY KEY,
  id_pedido INTEGER NOT NULL,
  id_variante_producto INTEGER NOT NULL,
  nombre_producto TEXT NOT NULL,
  sku TEXT,
  cantidad INTEGER NOT NULL,
  precio_unitario NUMERIC(12, 2) NOT NULL,
  subtotal NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_pedido_item_pedido
    FOREIGN KEY (id_pedido) REFERENCES public.pedido (id_pedido)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_pedido_item_variante
    FOREIGN KEY (id_variante_producto) REFERENCES public.variante_producto (id_variante_producto)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT ck_pedido_item_cantidad
    CHECK (cantidad > 0),
  CONSTRAINT ck_pedido_item_precio
    CHECK (precio_unitario >= 0),
  CONSTRAINT ck_pedido_item_subtotal
    CHECK (subtotal >= 0)
);

CREATE INDEX IF NOT EXISTS idx_pedido_item_pedido
  ON public.pedido_item (id_pedido);

CREATE INDEX IF NOT EXISTS idx_pedido_item_variante
  ON public.pedido_item (id_variante_producto);

COMMIT;

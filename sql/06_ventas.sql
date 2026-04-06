BEGIN;

CREATE TABLE IF NOT EXISTS public.venta (
  id_venta SERIAL PRIMARY KEY,
  id_pedido INTEGER,
  cedula_cliente TEXT NOT NULL,
  cliente_nombre TEXT NOT NULL,
  cliente_email TEXT,
  cliente_telefono TEXT,
  estado TEXT NOT NULL DEFAULT 'concretada',
  metodo_pago TEXT,
  referencia_pago TEXT,
  observacion TEXT,
  total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  id_usuario INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_venta_pedido
    FOREIGN KEY (id_pedido) REFERENCES public.pedido (id_pedido)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_venta_cliente
    FOREIGN KEY (cedula_cliente) REFERENCES public.cliente (cedula)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_venta_usuario
    FOREIGN KEY (id_usuario) REFERENCES public.usuario (id_usuario)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT ck_venta_estado
    CHECK (estado IN ('concretada', 'anulada')),
  CONSTRAINT ck_venta_total
    CHECK (total >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_venta_id_pedido_unico
  ON public.venta (id_pedido)
  WHERE id_pedido IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_venta_created_at
  ON public.venta (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_venta_estado
  ON public.venta (estado);

CREATE INDEX IF NOT EXISTS idx_venta_cedula_cliente
  ON public.venta (cedula_cliente);

CREATE INDEX IF NOT EXISTS idx_venta_usuario
  ON public.venta (id_usuario);

CREATE TABLE IF NOT EXISTS public.venta_item (
  id_venta_item SERIAL PRIMARY KEY,
  id_venta INTEGER NOT NULL,
  id_variante_producto INTEGER NOT NULL,
  nombre_producto TEXT NOT NULL,
  sku TEXT,
  cantidad INTEGER NOT NULL,
  precio_unitario NUMERIC(12, 2) NOT NULL,
  subtotal NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_venta_item_venta
    FOREIGN KEY (id_venta) REFERENCES public.venta (id_venta)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_venta_item_variante
    FOREIGN KEY (id_variante_producto) REFERENCES public.variante_producto (id_variante_producto)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT ck_venta_item_cantidad
    CHECK (cantidad > 0),
  CONSTRAINT ck_venta_item_precio
    CHECK (precio_unitario >= 0),
  CONSTRAINT ck_venta_item_subtotal
    CHECK (subtotal >= 0)
);

CREATE INDEX IF NOT EXISTS idx_venta_item_venta
  ON public.venta_item (id_venta);

CREATE INDEX IF NOT EXISTS idx_venta_item_variante
  ON public.venta_item (id_variante_producto);

COMMIT;

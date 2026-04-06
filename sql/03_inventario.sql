BEGIN;

CREATE TABLE IF NOT EXISTS public.inventario (
  id_variante_producto INTEGER PRIMARY KEY,
  stock INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_inventario_variante
    FOREIGN KEY (id_variante_producto) REFERENCES public.variante_producto (id_variante_producto)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT ck_inventario_stock_no_negativo
    CHECK (stock >= 0)
);

CREATE TABLE IF NOT EXISTS public.movimiento_inventario (
  id_movimiento_inventario SERIAL PRIMARY KEY,
  id_variante_producto INTEGER NOT NULL,
  tipo TEXT NOT NULL,
  cantidad INTEGER NOT NULL,
  motivo TEXT,
  ref_externa TEXT,
  costo_unitario NUMERIC(12, 2),
  id_usuario INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_movimiento_variante
    FOREIGN KEY (id_variante_producto) REFERENCES public.variante_producto (id_variante_producto)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_movimiento_usuario
    FOREIGN KEY (id_usuario) REFERENCES public.usuario (id_usuario)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT ck_movimiento_tipo
    CHECK (tipo IN ('entrada', 'salida', 'ajuste')),
  CONSTRAINT ck_movimiento_cantidad
    CHECK (cantidad > 0),
  CONSTRAINT ck_movimiento_costo
    CHECK (costo_unitario IS NULL OR costo_unitario >= 0)
);

CREATE INDEX IF NOT EXISTS idx_movimiento_inventario_created_at
  ON public.movimiento_inventario (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_movimiento_inventario_tipo
  ON public.movimiento_inventario (tipo);

CREATE INDEX IF NOT EXISTS idx_movimiento_inventario_variante
  ON public.movimiento_inventario (id_variante_producto);

CREATE INDEX IF NOT EXISTS idx_movimiento_inventario_usuario
  ON public.movimiento_inventario (id_usuario);

COMMIT;

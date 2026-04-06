BEGIN;

CREATE TABLE IF NOT EXISTS public.categoria (
  id_categoria SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  activo BOOLEAN NOT NULL DEFAULT true,
  eliminado BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.marca (
  id_marca SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  activo BOOLEAN NOT NULL DEFAULT true,
  eliminado BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.producto (
  id_producto SERIAL PRIMARY KEY,
  id_categoria INTEGER NOT NULL,
  id_marca INTEGER NOT NULL,
  nombre TEXT NOT NULL,
  sku_base TEXT,
  descripcion TEXT,
  activo BOOLEAN NOT NULL DEFAULT true,
  eliminado BOOLEAN NOT NULL DEFAULT false,
  fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_producto_categoria
    FOREIGN KEY (id_categoria) REFERENCES public.categoria (id_categoria)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_producto_marca
    FOREIGN KEY (id_marca) REFERENCES public.marca (id_marca)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_producto_sku_base
  ON public.producto (sku_base)
  WHERE sku_base IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_producto_estado_fecha
  ON public.producto (activo, eliminado, fecha_creacion DESC);

CREATE INDEX IF NOT EXISTS idx_producto_categoria
  ON public.producto (id_categoria);

CREATE INDEX IF NOT EXISTS idx_producto_marca
  ON public.producto (id_marca);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S'
      AND n.nspname = 'public'
      AND c.relname = 'variant_sku_seq'
  ) THEN
    CREATE SEQUENCE public.variant_sku_seq START 1 INCREMENT 1 MINVALUE 1;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.variante_producto (
  id_variante_producto SERIAL PRIMARY KEY,
  id_producto INTEGER NOT NULL,
  sku TEXT NOT NULL,
  precio_lista NUMERIC(12, 2),
  costo NUMERIC(12, 2),
  codigo_barras TEXT,
  atributos_json JSONB,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_variante_producto_producto
    FOREIGN KEY (id_producto) REFERENCES public.producto (id_producto)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT ck_variante_precio_lista
    CHECK (precio_lista IS NULL OR precio_lista >= 0),
  CONSTRAINT ck_variante_costo
    CHECK (costo IS NULL OR costo >= 0)
);

CREATE INDEX IF NOT EXISTS idx_variante_producto_producto
  ON public.variante_producto (id_producto);

CREATE INDEX IF NOT EXISTS idx_variante_producto_activo
  ON public.variante_producto (activo);

CREATE UNIQUE INDEX IF NOT EXISTS uq_variante_producto_sku_por_producto
  ON public.variante_producto (id_producto, sku);

CREATE TABLE IF NOT EXISTS public.imagen_producto (
  id_imagen_producto SERIAL PRIMARY KEY,
  id_producto INTEGER NOT NULL,
  id_variante_producto INTEGER,
  url TEXT NOT NULL,
  es_principal BOOLEAN NOT NULL DEFAULT false,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_imagen_producto_producto
    FOREIGN KEY (id_producto) REFERENCES public.producto (id_producto)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_imagen_producto_variante
    FOREIGN KEY (id_variante_producto) REFERENCES public.variante_producto (id_variante_producto)
    ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_imagen_producto_producto
  ON public.imagen_producto (id_producto);

CREATE INDEX IF NOT EXISTS idx_imagen_producto_variante
  ON public.imagen_producto (id_variante_producto);

CREATE UNIQUE INDEX IF NOT EXISTS uq_imagen_principal_activa_por_producto
  ON public.imagen_producto (id_producto)
  WHERE es_principal = true AND activo = true;

COMMIT;

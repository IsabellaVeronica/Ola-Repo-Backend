BEGIN;

CREATE TABLE IF NOT EXISTS public.expense_category (
  id_expense_category SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  metadata JSONB,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.expense_category
ADD COLUMN IF NOT EXISTS metadata JSONB;

CREATE TABLE IF NOT EXISTS public.cash_box (
  id_cash_box SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.cash_movement (
  id_cash_movement BIGSERIAL PRIMARY KEY,
  tipo TEXT NOT NULL,
  monto NUMERIC(12, 2) NOT NULL,
  metodo TEXT NOT NULL DEFAULT 'efectivo',
  id_expense_category INTEGER,
  id_cash_box INTEGER,
  referencia_tipo TEXT,
  referencia_id TEXT,
  nota TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  id_usuario INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_cash_movement_tipo
    CHECK (tipo IN ('ingreso', 'gasto')),
  CONSTRAINT ck_cash_movement_monto
    CHECK (monto > 0),
  CONSTRAINT fk_cash_movement_category
    FOREIGN KEY (id_expense_category) REFERENCES public.expense_category (id_expense_category)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_cash_movement_cash_box
    FOREIGN KEY (id_cash_box) REFERENCES public.cash_box (id_cash_box)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_cash_movement_user
    FOREIGN KEY (id_usuario) REFERENCES public.usuario (id_usuario)
    ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.venta_finanzas (
  id_venta INTEGER PRIMARY KEY,
  ingreso_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  costo_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  utilidad_bruta NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_venta_finanzas_ingreso
    CHECK (ingreso_total >= 0),
  CONSTRAINT ck_venta_finanzas_costo
    CHECK (costo_total >= 0),
  CONSTRAINT fk_venta_finanzas_venta
    FOREIGN KEY (id_venta) REFERENCES public.venta (id_venta)
    ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cash_movement_created_at
  ON public.cash_movement (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cash_movement_tipo
  ON public.cash_movement (tipo);

CREATE INDEX IF NOT EXISTS idx_cash_movement_category
  ON public.cash_movement (id_expense_category);

CREATE INDEX IF NOT EXISTS idx_cash_movement_cash_box
  ON public.cash_movement (id_cash_box);

CREATE INDEX IF NOT EXISTS idx_cash_movement_reference
  ON public.cash_movement (referencia_tipo, referencia_id);

CREATE INDEX IF NOT EXISTS idx_cash_movement_user
  ON public.cash_movement (id_usuario);

CREATE INDEX IF NOT EXISTS idx_venta_finanzas_created_at
  ON public.venta_finanzas (created_at DESC);

INSERT INTO public.expense_category (nombre, activo)
VALUES
  ('alquiler', true),
  ('publicidad', true),
  ('sueldos', true),
  ('servicios', true),
  ('otros', true),
  ('devolucion_venta', true)
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO public.cash_box (nombre, activo)
VALUES
  ('caja_principal', true),
  ('banco_principal', true)
ON CONFLICT (nombre) DO NOTHING;

COMMIT;

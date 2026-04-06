BEGIN;

CREATE TABLE IF NOT EXISTS public.rol (
  id_rol SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS public.usuario (
  id_usuario SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  eliminado BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.usuario_rol (
  id_usuario INTEGER NOT NULL,
  id_rol INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_usuario_rol PRIMARY KEY (id_usuario, id_rol),
  CONSTRAINT fk_usuario_rol_usuario
    FOREIGN KEY (id_usuario) REFERENCES public.usuario (id_usuario)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_usuario_rol_rol
    FOREIGN KEY (id_rol) REFERENCES public.rol (id_rol)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_usuario_activo_eliminado
  ON public.usuario (activo, eliminado);

CREATE INDEX IF NOT EXISTS idx_usuario_created_at
  ON public.usuario (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usuario_rol_id_rol
  ON public.usuario_rol (id_rol);

INSERT INTO public.rol (nombre)
VALUES
  ('admin'),
  ('manager'),
  ('vendedor'),
  ('viewer')
ON CONFLICT (nombre) DO NOTHING;

COMMIT;

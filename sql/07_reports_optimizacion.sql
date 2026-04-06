BEGIN;

CREATE INDEX IF NOT EXISTS idx_venta_estado_created_at
  ON public.venta (estado, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_venta_item_variante_venta
  ON public.venta_item (id_variante_producto, id_venta);

CREATE INDEX IF NOT EXISTS idx_inventario_stock
  ON public.inventario (stock);

COMMIT;

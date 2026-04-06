const { Router } = require('express');
const XLSX = require('xlsx');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// Helpers
function parseDate(s) { return (s || '').trim(); }
function toInt(v, d = 10) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function paginateRows(rows, pageRaw, limitRaw) {
  const page = Math.max(1, toInt(pageRaw, 1));
  const limit = Math.min(200, Math.max(1, toInt(limitRaw, 25)));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const offset = (page - 1) * limit;
  return {
    data: rows.slice(offset, offset + limit),
    page,
    limit,
    total,
    pages
  };
}
function csvEscape(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function getReposicionRows(windowDays, coverageDays, minReponer) {
  const { rows } = await pool.query(
    `
    WITH ventas_periodo AS (
      SELECT
        vi.id_variante_producto,
        COALESCE(SUM(vi.cantidad), 0)::int AS ventas_window
      FROM public.venta_item vi
      JOIN public.venta v ON v.id_venta = vi.id_venta
      WHERE v.estado = 'concretada'
        AND v.created_at >= (NOW() - make_interval(days => $1::int))
      GROUP BY vi.id_variante_producto
    ),
    base AS (
      SELECT
        p.id_producto,
        p.nombre AS producto,
        vp.id_variante_producto,
        vp.sku,
        COALESCE(i.stock, 0)::int AS stock_actual,
        COALESCE(vw.ventas_window, 0)::int AS ventas_window,
        ROUND((COALESCE(vw.ventas_window, 0)::numeric / GREATEST($1::int, 1)), 4)::float AS consumo_diario,
        CEIL((COALESCE(vw.ventas_window, 0)::numeric / GREATEST($1::int, 1)) * $2::int)::int AS stock_objetivo,
        COALESCE(vp.costo, 0)::float AS costo
      FROM public.variante_producto vp
      JOIN public.producto p ON p.id_producto = vp.id_producto
      LEFT JOIN public.inventario i ON i.id_variante_producto = vp.id_variante_producto
      LEFT JOIN ventas_periodo vw ON vw.id_variante_producto = vp.id_variante_producto
      WHERE p.activo = true
        AND p.eliminado = false
        AND vp.activo = true
    )
    SELECT
      b.*,
      GREATEST(b.stock_objetivo - b.stock_actual, 0)::int AS reponer,
      ROUND((GREATEST(b.stock_objetivo - b.stock_actual, 0) * b.costo)::numeric, 2)::float AS valor_reposicion
    FROM base b
    WHERE GREATEST(b.stock_objetivo - b.stock_actual, 0) >= $3
    ORDER BY reponer DESC, ventas_window DESC, producto, sku
    `,
    [windowDays, coverageDays, minReponer]
  );
  return rows;
}

// Etiquetas legibles para acciones de auditorÃ­a
const ACTION_LABELS = {
  CREATE_USER: 'CreÃ³ usuario',
  CREATE_USER_SIGNUP: 'Signup de usuario',
  REPLACE_ROLES: 'ActualizÃ³ roles',
  RESET_PASSWORD: 'ReseteÃ³ contraseÃ±a',
  ENABLE: 'ActivÃ³ usuario',
  DISABLE: 'DesactivÃ³ usuario',
  PRODUCT_CREATE: 'CreÃ³ producto',
  PRODUCT_CREATE_WITH_VARIANT: 'CreÃ³ producto (con variante)',
  PRODUCT_UPDATE: 'ActualizÃ³ producto',
  PRODUCT_DISABLE: 'DesactivÃ³ producto',
  CAT_CREATE: 'CreÃ³ categorÃ­a',
  CAT_UPDATE: 'ActualizÃ³ categorÃ­a',
  CAT_DISABLE: 'DesactivÃ³ categorÃ­a',
  BRAND_CREATE: 'CreÃ³ marca',
  BRAND_UPDATE: 'ActualizÃ³ marca',
  BRAND_DISABLE: 'DesactivÃ³ marca',
  VARIANT_CREATE: 'CreÃ³ variante',
  VARIANT_UPDATE: 'ActualizÃ³ variante',
  VARIANT_PRICE_CHANGE: 'Cambio de precio/costo',
  VARIANT_DISABLE: 'DesactivÃ³ variante',
  INV_ENTRADA: 'Entrada de inventario',
  INV_SALIDA: 'Salida de inventario',
  INV_AJUSTE: 'Ajuste de inventario',
  PEDIDO_CREAR: 'CreÃ³ pedido',
  PEDIDO_CAMBIAR_ESTADO: 'CambiÃ³ estado de pedido',
  VENTA_CREAR: 'CreÃ³ venta',
  VENTA_ANULAR: 'Anuló venta',
  USUARIO_UPDATE_PERFIL: 'ActualizÃ³ perfil',
  USUARIO_UPDATE_PASSWORD: 'CambiÃ³ contraseÃ±a',
  SOFT_DELETE_USER: 'EliminÃ³ usuario',
  PRODUCT_SOFT_DELETE: 'EliminÃ³ producto',
  BRAND_SOFT_DELETE: 'EliminÃ³ marca',
  CAT_SOFT_DELETE: 'EliminÃ³ categorÃ­a'
};

// Resumen legible del payload segÃºn acciÃ³n
function formatDetail(action, payload) {
  if (!payload) return '';
  let data = payload;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return payload; }
  }

  switch (action) {
    case 'REPLACE_ROLES':
      return data.roles ? `Roles: ${data.roles.join(', ')}` : '';
    case 'ENABLE':
    case 'DISABLE':
      return data.activo !== undefined ? `Activo: ${data.activo}` : '';
    case 'RESET_PASSWORD':
      return data.by ? `Reseteada por: ${data.by}` : '';
    case 'CREATE_USER_SIGNUP':
    case 'CREATE_USER':
      return data.email ? `Email: ${data.email} | Rol: ${data.rol || data.roles}` : '';
    case 'VARIANT_UPDATE':
      return data.changes ? `Cambios: ${JSON.stringify(data.changes)}` : '';
    case 'VARIANT_PRICE_CHANGE':
      return data.prev || data.next
        ? `Precio ${JSON.stringify(data.prev || {})} â†’ ${JSON.stringify(data.next || {})}`
        : '';
    case 'VARIANT_DISABLE':
    case 'VARIANT_CREATE':
      return data.sku ? `SKU: ${data.sku}` : '';
    case 'INV_ENTRADA':
    case 'INV_SALIDA':
    case 'INV_AJUSTE':
      return data.cantidad
        ? `Cant: ${data.cantidad} | Stock ${data.stock_antes} â†’ ${data.stock_despues}`
        : '';
    case 'PEDIDO_CREAR':
      return data.total !== undefined ? `Total: ${data.total} | Items: ${data.items?.length || 0}` : '';
    case 'PEDIDO_CAMBIAR_ESTADO':
      return data.estado ? `Estado: ${data.estado}` : '';
    case 'VENTA_CREAR':
      return data.id_venta ? `Venta #${data.id_venta} | Total: ${data.total || 0}` : '';
    case 'VENTA_ANULAR':
      return data.id_venta ? `Venta anulada #${data.id_venta}` : '';
    case 'USUARIO_UPDATE_PERFIL':
      return `Nombre: ${data.nombre} | Email: ${data.email}`;
    case 'USUARIO_UPDATE_PASSWORD':
      return 'ContraseÃ±a actualizada por el usuario';
    case 'SOFT_DELETE_USER':
      return data.deleted_user_nombre
        ? `Usuario: ${data.deleted_user_nombre} (ID: ${data.deleted_user_id})`
        : (data.deleted_user_id ? `ID Usuario eliminado: ${data.deleted_user_id}` : 'Usuario eliminado');
    case 'PRODUCT_SOFT_DELETE':
      return data.deleted_product_nombre
        ? `Producto: ${data.deleted_product_nombre} (ID: ${data.id_producto})`
        : (data.id_producto ? `ID Producto eliminado: ${data.id_producto}` : 'Producto eliminado');
    case 'BRAND_SOFT_DELETE':
      return data.nombre ? `Marca: ${data.nombre} (ID: ${data.id_marca})` : `Marca ID: ${data.id_marca}`;
    case 'CAT_SOFT_DELETE':
      return data.nombre ? `CategorÃ­a: ${data.nombre} (ID: ${data.id_categoria})` : `CategorÃ­a ID: ${data.id_categoria}`;
    case 'PRODUCT_CREATE_WITH_VARIANT':
      return data.id_producto ? `ID Producto: ${data.id_producto} | ID Variante: ${data.variant_id}` : '';
    case 'PRODUCT_CREATE':
      return data.id_producto ? `ID Producto: ${data.id_producto}` : '';
    case 'CAT_CREATE':
      return data.id_categoria ? `ID CategorÃ­a: ${data.id_categoria} | Nombre: ${data.nombre}` : '';
    case 'BRAND_CREATE':
      return data.id_marca ? `ID Marca: ${data.id_marca} | Nombre: ${data.nombre}` : '';
    default:
      return typeof data === 'object' ? JSON.stringify(data) : String(data);
  }
}

/**
 * 1) KPIs de pedidos (resumen)
 * GET /api/reports/pedidos/kpis?from=YYYY-MM-DD&to=YYYY-MM-DD
 * - total_pedidos
 * - total_concretados
 * - conversion (concretados / total)
 * - monto_total_estimado (suma total_estimado de concretados)
 * - ticket_promedio (monto_total_estimado / concretados)
 */
router.get('/reports/pedidos/kpis',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);

      const conds = [];
      const params = [];
      let i = 1;
      if (from) { conds.push(`p.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to) { conds.push(`p.created_at <  ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const { rows } = await pool.query(
        `
        WITH base AS (
          SELECT p.id_pedido, p.estado, COALESCE(p.total_estimado,0)::numeric AS total
          FROM public.pedido p
          ${where}
        )
        SELECT
          COUNT(*)::int                                         AS total_pedidos,
          SUM(CASE WHEN estado='concretado' THEN 1 ELSE 0 END)::int AS total_concretados,
          COALESCE(SUM(CASE WHEN estado='concretado' THEN total END),0)::float AS monto_total_estimado,
          CASE WHEN SUM(CASE WHEN estado='concretado' THEN 1 ELSE 0 END) = 0
               THEN 0
               ELSE ROUND(
                 COALESCE(SUM(CASE WHEN estado='concretado' THEN total END),0)
                 / NULLIF(SUM(CASE WHEN estado='concretado' THEN 1 ELSE 0 END),0)
               ,2)
          END AS ticket_promedio
        FROM base
        `,
        params
      );

      const k = rows[0] || { total_pedidos: 0, total_concretados: 0, monto_total_estimado: 0, ticket_promedio: 0 };
      const conversion = k.total_pedidos ? +(k.total_concretados / k.total_pedidos).toFixed(2) : 0;

      res.json({ ...k, conversion });
    } catch (err) { next(err); }
  }
);

/**
 * 2) Serie temporal de pedidos
 * GET /api/reports/pedidos/serie?from=&to=&granularity=month|day
 * Devuelve: fecha (inicio), total, concretados, monto_concretado
 */
router.get('/reports/pedidos/serie',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);
      const g = graw ? String(graw).trim().toLowerCase() : 'month';
      const gran = (g === 'day' || g === 'month' || g === 'year') ? g : 'month';

      const conds = [];
      const params = [];
      let i = 1;
      if (from) { conds.push(`p.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to) { conds.push(`p.created_at <  ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const { rows } = await pool.query(
        `
        SELECT
          date_trunc('${gran}', p.created_at) AS periodo,
          COUNT(*)::int AS total,
          SUM(CASE WHEN p.estado='concretado' THEN 1 ELSE 0 END)::int AS concretados,
          COALESCE(SUM(CASE WHEN p.estado='concretado' THEN p.total_estimado END),0)::float AS monto_concretado
        FROM public.pedido p
        ${where}
        GROUP BY 1
        ORDER BY 1
        `,
        params
      );

      res.json({
        granularity: gran, data: rows.map(r => ({
          periodo: r.periodo.toISOString(),
          total: r.total,
          concretados: r.concretados,
          monto_concretado: r.monto_concretado
        }))
      });
    } catch (err) { next(err); }
  }
);

/**
 * 3) Top productos por salidas (movimiento_inventario)
 * GET /api/reports/inventario/top-salidas?from=&to=&limit=10
 * Agrupa por producto/variante y ordena por cantidad total salida.
 */
router.get('/reports/inventario/top-salidas',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);
      const limit = toInt(req.query.limit, 10);

      const conds = [`m.tipo='salida'`];
      const params = [];
      let i = 1;
      if (from) { conds.push(`m.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to) { conds.push(`m.created_at <  ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
      const where = `WHERE ${conds.join(' AND ')}`;

      const { rows } = await pool.query(
        `
        SELECT
          p.id_producto,
          p.nombre AS producto,
          v.id_variante_producto,
          v.sku,
          SUM(m.cantidad)::int AS total_salidas
        FROM public.movimiento_inventario m
        JOIN public.variante_producto v ON v.id_variante_producto = m.id_variante_producto
        JOIN public.producto p          ON p.id_producto = v.id_producto
        ${where}
        GROUP BY 1,2,3,4
        ORDER BY total_salidas DESC
        LIMIT ${limit}
        `,
        params
      );

      res.json({ data: rows });
    } catch (err) { next(err); }
  }
);

/**
 * 4) Salidas por periodo (serie)
 * GET /api/reports/inventario/salidas-serie?from=&to=&granularity=month|day
 * Cuenta y suma cantidades de salidas.
 */
router.get('/reports/inventario/salidas-serie',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);
      const gran = (req.query.granularity || 'month').toLowerCase() === 'day' ? 'day' : 'month';

      const conds = [`m.tipo='salida'`];
      const params = [];
      let i = 1;
      if (from) { conds.push(`m.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to) { conds.push(`m.created_at <  ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
      const where = `WHERE ${conds.join(' AND ')}`;

      const { rows } = await pool.query(
        `
        SELECT
          date_trunc('${gran}', m.created_at) AS periodo,
          COUNT(*)::int AS movimientos,
          COALESCE(SUM(m.cantidad),0)::int AS unidades
        FROM public.movimiento_inventario m
        ${where}
        GROUP BY 1
        ORDER BY 1
        `,
        params
      );

      res.json({
        granularity: gran, data: rows.map(r => ({
          periodo: r.periodo.toISOString(),
          movimientos: r.movimientos,
          unidades: r.unidades
        }))
      });
    } catch (err) { next(err); }
  }
);

/**
 * 5) Alertas de stock bajo
 * GET /api/reports/alertas/stock-bajo?threshold=5
 * - threshold: si no tienes min_stock en BD, usa este parÃ¡metro.
 * - Filtra variantes y productos activos con stock <= threshold.
 */
router.get('/reports/alertas/stock-bajo',
  requireAuth, requireRole('admin', 'manager', 'vendedor'),
  async (req, res, next) => {
    try {
      const threshold = toInt(req.query.threshold, 5);

      const { rows } = await pool.query(
        `
        SELECT
          p.id_producto,
          p.nombre AS producto,
          v.id_variante_producto,
          v.sku,
          COALESCE(i.stock,0)::int AS stock,
          COALESCE(v.activo, true) AS variante_activa,
          p.activo AS producto_activo
        FROM public.producto p
        LEFT JOIN public.variante_producto v ON v.id_producto = p.id_producto
        LEFT JOIN public.inventario i        ON i.id_variante_producto = v.id_variante_producto
        WHERE p.activo = true
          AND (v.id_variante_producto IS NULL OR v.activo = true)
          AND COALESCE(i.stock,0) <= $1
        ORDER BY i.stock ASC, p.nombre, v.sku
        `,
        [threshold]
      );

      res.json({ threshold, data: rows });
    } catch (err) { next(err); }
  }
);

/**
 * 6) Stock Actual (operativo)
 * GET /api/reports/inventario/stock-actual
 * Filtra solo productos y variantes activas.
 */
router.get('/reports/inventario/stock-actual',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `
        SELECT
          p.id_producto,
          p.nombre AS producto,
          v.id_variante_producto,
          v.sku,
          COALESCE(i.stock,0)::int AS stock
        FROM public.producto p
        LEFT JOIN public.variante_producto v ON v.id_producto = p.id_producto
        LEFT JOIN public.inventario i        ON i.id_variante_producto = v.id_variante_producto
        WHERE p.activo = true
          AND (v.id_variante_producto IS NULL OR v.activo = true)
        ORDER BY p.nombre, v.sku
        `
      );
      res.json({ data: rows });
    } catch (err) { next(err); }
  }
);

/**
 * Vista previa para visualizador de reportes (sin descargar archivo)
 * GET /api/reports/inventario/preview?report=stock-actual|alertas-stock|valor-inventario|estancados|reposicion|historial-salidas&page=1&limit=25
 */
router.get('/reports/inventario/preview',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const report = String(req.query.report || 'stock-actual').trim().toLowerCase();
      const pageRaw = req.query.page;
      const limitRaw = req.query.limit;

      let rows = [];
      let columns = [];
      let summary = {};
      let filters = {};

      if (report === 'stock-actual' || report === 'stock') {
        const { rows: r } = await pool.query(
          `
          SELECT
            p.id_producto,
            p.nombre AS producto,
            v.id_variante_producto,
            v.sku,
            COALESCE(i.stock,0)::int AS stock
          FROM public.producto p
          LEFT JOIN public.variante_producto v ON v.id_producto = p.id_producto
          LEFT JOIN public.inventario i        ON i.id_variante_producto = v.id_variante_producto
          WHERE p.activo = true
            AND (v.id_variante_producto IS NULL OR v.activo = true)
          ORDER BY p.nombre, v.sku
          `
        );
        rows = r;
        columns = [
          { key: 'producto', label: 'Producto', type: 'text' },
          { key: 'sku', label: 'SKU', type: 'text' },
          { key: 'stock', label: 'Stock', type: 'number' }
        ];
        summary = {
          unidades_totales: rows.reduce((s, x) => s + Number(x.stock || 0), 0),
          variantes: rows.length
        };
      } else if (report === 'alertas-stock' || report === 'stock-bajo' || report === 'alertas') {
        const threshold = toInt(req.query.threshold, 5);
        const { rows: r } = await pool.query(
          `
          SELECT
            p.id_producto,
            p.nombre AS producto,
            v.id_variante_producto,
            v.sku,
            COALESCE(i.stock,0)::int AS stock
          FROM public.producto p
          LEFT JOIN public.variante_producto v ON v.id_producto = p.id_producto
          LEFT JOIN public.inventario i        ON i.id_variante_producto = v.id_variante_producto
          WHERE p.activo = true
            AND (v.id_variante_producto IS NULL OR v.activo = true)
            AND COALESCE(i.stock,0) <= $1
          ORDER BY i.stock ASC, p.nombre, v.sku
          `,
          [threshold]
        );
        rows = r;
        columns = [
          { key: 'producto', label: 'Producto', type: 'text' },
          { key: 'sku', label: 'SKU', type: 'text' },
          { key: 'stock', label: 'Stock', type: 'number' }
        ];
        summary = { alertas: rows.length };
        filters = { threshold };
      } else if (report === 'valor-inventario' || report === 'valor') {
        const includeZeroStock = String(req.query.include_zero_stock || '').trim().toLowerCase() === 'true';
        const stockCond = includeZeroStock ? 'TRUE' : 'COALESCE(i.stock, 0) > 0';
        const { rows: r } = await pool.query(
          `
          SELECT
            p.id_producto,
            p.nombre AS producto,
            vp.id_variante_producto,
            vp.sku,
            COALESCE(i.stock, 0)::int AS stock,
            COALESCE(vp.costo, 0)::float AS costo,
            ROUND((COALESCE(i.stock, 0) * COALESCE(vp.costo, 0))::numeric, 2)::float AS valor
          FROM public.variante_producto vp
          JOIN public.producto p ON p.id_producto = vp.id_producto
          LEFT JOIN public.inventario i ON i.id_variante_producto = vp.id_variante_producto
          WHERE p.activo = true
            AND p.eliminado = false
            AND vp.activo = true
            AND ${stockCond}
          ORDER BY valor DESC, p.nombre, vp.sku
          `
        );
        rows = r;
        columns = [
          { key: 'producto', label: 'Producto', type: 'text' },
          { key: 'sku', label: 'SKU', type: 'text' },
          { key: 'stock', label: 'Stock', type: 'number' },
          { key: 'costo', label: 'Costo', type: 'money' },
          { key: 'valor', label: 'Valor', type: 'money' }
        ];
        summary = {
          total_valor_inventario: Number(rows.reduce((s, x) => s + Number(x.valor || 0), 0).toFixed(2)),
          total_unidades: rows.reduce((s, x) => s + Number(x.stock || 0), 0)
        };
        filters = { include_zero_stock: includeZeroStock };
      } else if (report === 'estancados' || report === 'riesgo-estancados') {
        const days = Math.max(1, toInt(req.query.days, 60));
        const { rows: r } = await pool.query(
          `
          WITH ultima_venta AS (
            SELECT
              vi.id_variante_producto,
              MAX(v.created_at)::date AS ultima_venta
            FROM public.venta_item vi
            JOIN public.venta v ON v.id_venta = vi.id_venta
            WHERE v.estado = 'concretada'
            GROUP BY vi.id_variante_producto
          ),
          base AS (
            SELECT
              p.id_producto,
              p.nombre AS producto,
              vp.id_variante_producto,
              vp.sku,
              COALESCE(i.stock, 0)::int AS stock,
              uv.ultima_venta,
              COALESCE(uv.ultima_venta, vp.created_at::date, p.fecha_creacion::date, p.created_at::date, CURRENT_DATE) AS fecha_referencia
            FROM public.variante_producto vp
            JOIN public.producto p ON p.id_producto = vp.id_producto
            LEFT JOIN public.inventario i ON i.id_variante_producto = vp.id_variante_producto
            LEFT JOIN ultima_venta uv ON uv.id_variante_producto = vp.id_variante_producto
            WHERE p.activo = true
              AND p.eliminado = false
              AND vp.activo = true
              AND COALESCE(i.stock, 0) > 0
          )
          SELECT
            b.id_producto,
            b.producto,
            b.id_variante_producto,
            b.sku,
            b.stock,
            b.ultima_venta,
            (CURRENT_DATE - b.fecha_referencia)::int AS dias_sin_vender,
            (b.ultima_venta IS NULL) AS nunca_vendido
          FROM base b
          WHERE (CURRENT_DATE - b.fecha_referencia) >= $1
          ORDER BY
            (b.ultima_venta IS NULL) DESC,
            dias_sin_vender DESC NULLS LAST,
            b.stock DESC,
            b.producto,
            b.sku
          `,
          [days]
        );
        rows = r;
        columns = [
          { key: 'producto', label: 'Producto', type: 'text' },
          { key: 'sku', label: 'SKU', type: 'text' },
          { key: 'stock', label: 'Stock', type: 'number' },
          { key: 'dias_sin_vender', label: 'Dias sin vender', type: 'number' },
          { key: 'ultima_venta', label: 'Ultima venta', type: 'date' }
        ];
        summary = { estancados: rows.length };
        filters = { days };
      } else if (report === 'reposicion' || report === 'asistente-compra') {
        const windowDays = Math.max(1, toInt(req.query.window_days, 30));
        const coverageDays = Math.max(1, toInt(req.query.coverage_days, 21));
        const minReponer = Math.max(0, toInt(req.query.min_reponer, 1));
        rows = await getReposicionRows(windowDays, coverageDays, minReponer);
        columns = [
          { key: 'producto', label: 'Producto', type: 'text' },
          { key: 'sku', label: 'SKU', type: 'text' },
          { key: 'stock_actual', label: 'Stock actual', type: 'number' },
          { key: 'ventas_window', label: 'Ventas', type: 'number' },
          { key: 'stock_objetivo', label: 'Stock objetivo', type: 'number' },
          { key: 'reponer', label: 'Pedir', type: 'number' },
          { key: 'valor_reposicion', label: 'Valor reposicion', type: 'money' }
        ];
        summary = {
          total_items_reponer: rows.length,
          total_unidades_reponer: rows.reduce((s, x) => s + Number(x.reponer || 0), 0),
          total_valor_reposicion: Number(rows.reduce((s, x) => s + Number(x.valor_reposicion || 0), 0).toFixed(2))
        };
        filters = { window_days: windowDays, coverage_days: coverageDays, min_reponer: minReponer };
      } else if (report === 'historial-salidas' || report === 'movimientos-detalle') {
        const from = parseDate(req.query.from);
        const to = parseDate(req.query.to);
        const conds = [`m.tipo = 'salida'`];
        const params = [];
        let i = 1;
        if (from) { conds.push(`m.created_at >= $${i++}::timestamptz`); params.push(from); }
        if (to) { conds.push(`m.created_at < ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

        const { rows: r } = await pool.query(
          `
          SELECT
            m.id_movimiento_inventario AS id_salida,
            m.created_at AS fecha,
            p.nombre AS producto,
            v.sku,
            m.cantidad,
            m.motivo,
            m.ref_externa AS referencia,
            u.nombre AS autorizado_por,
            COALESCE(m.costo_unitario,0)::float AS costo_unit,
            COALESCE(m.cantidad * m.costo_unitario, 0)::float AS subtotal
          FROM public.movimiento_inventario m
          JOIN public.variante_producto v ON v.id_variante_producto = m.id_variante_producto
          JOIN public.producto p          ON p.id_producto = v.id_producto
          LEFT JOIN public.usuario u      ON u.id_usuario = m.id_usuario
          ${where}
          ORDER BY m.created_at DESC
          `,
          params
        );
        rows = r;
        columns = [
          { key: 'fecha', label: 'Fecha', type: 'datetime' },
          { key: 'producto', label: 'Producto', type: 'text' },
          { key: 'sku', label: 'SKU', type: 'text' },
          { key: 'cantidad', label: 'Cantidad', type: 'number' },
          { key: 'subtotal', label: 'Subtotal', type: 'money' },
          { key: 'referencia', label: 'Referencia', type: 'text' }
        ];
        summary = {
          total_movimientos: rows.length,
          total_unidades: rows.reduce((s, x) => s + Number(x.cantidad || 0), 0)
        };
        filters = { from: from || null, to: to || null };
      } else {
        return res.status(400).json({
          message: 'Reporte no soportado para vista previa',
          supported_reports: [
            'stock-actual',
            'alertas-stock',
            'valor-inventario',
            'estancados',
            'reposicion',
            'historial-salidas'
          ]
        });
      }

      const pageResult = paginateRows(rows, pageRaw, limitRaw);
      return res.json({
        report,
        columns,
        summary,
        filters,
        ...pageResult
      });
    } catch (err) { return next(err); }
  }
);

/**
 * 7) Productos estancados (inventario muerto)
 * GET /api/reports/inventario/estancados?days=60&limit=200
 * Usa ventas concretadas para calcular ultima venta real.
 */
router.get('/reports/inventario/estancados',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const days = Math.max(1, toInt(req.query.days, 60));
      const limit = Math.min(1000, Math.max(1, toInt(req.query.limit, 200)));

      const { rows } = await pool.query(
        `
        WITH ultima_venta AS (
          SELECT
            vi.id_variante_producto,
            MAX(v.created_at)::date AS ultima_venta
          FROM public.venta_item vi
          JOIN public.venta v ON v.id_venta = vi.id_venta
          WHERE v.estado = 'concretada'
          GROUP BY vi.id_variante_producto
        ),
        base AS (
          SELECT
            p.id_producto,
            p.nombre AS producto,
            vp.id_variante_producto,
            vp.sku,
            COALESCE(i.stock, 0)::int AS stock,
            uv.ultima_venta,
            COALESCE(uv.ultima_venta, vp.created_at::date, p.fecha_creacion::date, p.created_at::date, CURRENT_DATE) AS fecha_referencia
          FROM public.variante_producto vp
          JOIN public.producto p ON p.id_producto = vp.id_producto
          LEFT JOIN public.inventario i ON i.id_variante_producto = vp.id_variante_producto
          LEFT JOIN ultima_venta uv ON uv.id_variante_producto = vp.id_variante_producto
          WHERE p.activo = true
            AND p.eliminado = false
            AND vp.activo = true
            AND COALESCE(i.stock, 0) > 0
        )
        SELECT
          b.id_producto,
          b.producto,
          b.id_variante_producto,
          b.sku,
          b.stock,
          b.ultima_venta,
          (CURRENT_DATE - b.fecha_referencia)::int AS dias_sin_vender,
          (b.ultima_venta IS NULL) AS nunca_vendido
        FROM base b
        WHERE (CURRENT_DATE - b.fecha_referencia) >= $1
        ORDER BY
          (b.ultima_venta IS NULL) DESC,
          dias_sin_vender DESC NULLS LAST,
          b.stock DESC,
          b.producto,
          b.sku
        LIMIT ${limit}
        `,
        [days]
      );

      res.json({ days, data: rows });
    } catch (err) { next(err); }
  }
);

/**
 * 8) Valor de inventario
 * GET /api/reports/inventario/valor?include_zero_stock=false
 */
router.get('/reports/inventario/valor',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const includeZeroStock = String(req.query.include_zero_stock || '').trim().toLowerCase() === 'true';
      const stockCond = includeZeroStock ? 'TRUE' : 'COALESCE(i.stock, 0) > 0';

      const { rows } = await pool.query(
        `
        SELECT
          p.id_producto,
          p.nombre AS producto,
          vp.id_variante_producto,
          vp.sku,
          COALESCE(i.stock, 0)::int AS stock,
          COALESCE(vp.costo, 0)::float AS costo,
          ROUND((COALESCE(i.stock, 0) * COALESCE(vp.costo, 0))::numeric, 2)::float AS valor
        FROM public.variante_producto vp
        JOIN public.producto p ON p.id_producto = vp.id_producto
        LEFT JOIN public.inventario i ON i.id_variante_producto = vp.id_variante_producto
        WHERE p.activo = true
          AND p.eliminado = false
          AND vp.activo = true
          AND ${stockCond}
        ORDER BY valor DESC, p.nombre, vp.sku
        `
      );

      const totalValorInventario = rows.reduce((sum, r) => sum + Number(r.valor || 0), 0);
      const totalUnidades = rows.reduce((sum, r) => sum + Number(r.stock || 0), 0);

      res.json({
        include_zero_stock: includeZeroStock,
        summary: {
          total_variantes: rows.length,
          total_unidades: totalUnidades,
          total_valor_inventario: Number(totalValorInventario.toFixed(2))
        },
        data: rows
      });
    } catch (err) { next(err); }
  }
);

/**
 * 9) Reposicion inteligente
 * GET /api/reports/inventario/reposicion?window_days=30&coverage_days=21&min_reponer=1
 */
router.get('/reports/inventario/reposicion',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const windowDays = Math.max(1, toInt(req.query.window_days, 30));
      const coverageDays = Math.max(1, toInt(req.query.coverage_days, 21));
      const minReponer = Math.max(0, toInt(req.query.min_reponer, 1));
      const rows = await getReposicionRows(windowDays, coverageDays, minReponer);

      res.json({
        window_days: windowDays,
        coverage_days: coverageDays,
        min_reponer: minReponer,
        data: rows
      });
    } catch (err) { next(err); }
  }
);

/**
 * 9b) Export asistente de compra (CSV/XLSX)
 * GET /api/reports/inventario/reposicion/export?format=csv|xlsx
 */
const reposicionExportPaths = [
  '/reports/inventario/reposicion/export',
  '/reports/inventario/asistente-compra/export',
  '/reports/inventario/reposicion/download',
  '/reports/inventario/asistente-compra/download',
  '/reports/inventario/asistente-compra'
];

const reposicionExportPostPaths = [
  ...reposicionExportPaths,
  '/reports/inventario/reposicion'
];

async function reposicionExportHandler(req, res, next) {
  try {
    const q = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const windowDays = Math.max(1, toInt(q.window_days, 30));
    const coverageDays = Math.max(1, toInt(q.coverage_days, 21));
    const minReponer = Math.max(0, toInt(q.min_reponer, 1));
    const formatRaw = String(q.format || q.fmt || 'csv').trim().toLowerCase();
    const format = formatRaw === 'xlsx' ? 'xlsx' : 'csv';

    const rows = await getReposicionRows(windowDays, coverageDays, minReponer);

    if (format === 'xlsx') {
      const book = XLSX.utils.book_new();
      const sheet = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(book, sheet, 'AsistenteCompra');
      const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=\"asistente_compra_${Date.now()}.xlsx\"`);
      return res.status(200).send(buffer);
    }

    const headers = [
      'id_producto',
      'producto',
      'id_variante_producto',
      'sku',
      'stock_actual',
      'ventas_window',
      'consumo_diario',
      'stock_objetivo',
      'reponer',
      'costo',
      'valor_reposicion'
    ];
    const lines = [headers.join(',')];
    for (const row of rows) {
      lines.push(headers.map((h) => csvEscape(row[h])).join(','));
    }
    const csv = `\uFEFF${lines.join('\n')}`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=\"asistente_compra_${Date.now()}.csv\"`);
    return res.status(200).send(csv);
  } catch (err) { return next(err); }
}

router.get(
  reposicionExportPaths,
  requireAuth, requireRole('admin', 'manager'),
  reposicionExportHandler
);

router.post(
  reposicionExportPostPaths,
  requireAuth, requireRole('admin', 'manager'),
  reposicionExportHandler
);

/**
 * 10) Dashboard ideal de inventario
 * GET /api/reports/inventario/dashboard?low_stock=5&stagnant_days=60&high_rotation=10
 */
router.get('/reports/inventario/dashboard',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const lowStock = Math.max(0, toInt(req.query.low_stock, 5));
      const stagnantDays = Math.max(1, toInt(req.query.stagnant_days, 60));
      const highRotation = Math.max(1, toInt(req.query.high_rotation, 10));

      const { rows } = await pool.query(
        `
        WITH base AS (
          SELECT
            p.id_producto,
            vp.id_variante_producto,
            COALESCE(i.stock, 0)::int AS stock,
            COALESCE(vp.costo, 0)::numeric AS costo,
            COALESCE(vp.created_at::date, p.fecha_creacion::date, p.created_at::date, CURRENT_DATE) AS fecha_referencia
          FROM public.variante_producto vp
          JOIN public.producto p ON p.id_producto = vp.id_producto
          LEFT JOIN public.inventario i ON i.id_variante_producto = vp.id_variante_producto
          WHERE p.activo = true
            AND p.eliminado = false
            AND vp.activo = true
        ),
        ventas_30 AS (
          SELECT
            vi.id_variante_producto,
            COALESCE(SUM(vi.cantidad), 0)::int AS ventas_30
          FROM public.venta_item vi
          JOIN public.venta v ON v.id_venta = vi.id_venta
          WHERE v.estado = 'concretada'
            AND v.created_at >= (NOW() - INTERVAL '30 days')
          GROUP BY vi.id_variante_producto
        ),
        ultima_venta AS (
          SELECT
            vi.id_variante_producto,
            MAX(v.created_at)::date AS ultima_venta
          FROM public.venta_item vi
          JOIN public.venta v ON v.id_venta = vi.id_venta
          WHERE v.estado = 'concretada'
          GROUP BY vi.id_variante_producto
        )
        SELECT
          COUNT(DISTINCT b.id_producto)::int AS productos_totales,
          COALESCE(SUM(b.stock), 0)::int AS unidades_totales,
          ROUND(COALESCE(SUM((b.stock * b.costo)), 0)::numeric, 2)::float AS valor_inventario,
          COUNT(DISTINCT CASE WHEN b.stock <= $1 THEN b.id_variante_producto END)::int AS stock_bajo_variantes,
          COUNT(DISTINCT CASE WHEN b.stock <= $1 THEN b.id_producto END)::int AS stock_bajo_productos,
          COUNT(DISTINCT CASE
            WHEN b.stock > 0
             AND (CURRENT_DATE - COALESCE(uv.ultima_venta, b.fecha_referencia)) >= $2
            THEN b.id_variante_producto
          END)::int AS estancados_variantes,
          COUNT(DISTINCT CASE
            WHEN b.stock > 0
             AND (CURRENT_DATE - COALESCE(uv.ultima_venta, b.fecha_referencia)) >= $2
            THEN b.id_producto
          END)::int AS estancados_productos,
          COUNT(DISTINCT CASE
            WHEN COALESCE(v30.ventas_30, 0) >= $3 THEN b.id_variante_producto
          END)::int AS alta_rotacion_variantes,
          COUNT(DISTINCT CASE
            WHEN COALESCE(v30.ventas_30, 0) >= $3 THEN b.id_producto
          END)::int AS alta_rotacion_productos
        FROM base b
        LEFT JOIN ventas_30 v30 ON v30.id_variante_producto = b.id_variante_producto
        LEFT JOIN ultima_venta uv ON uv.id_variante_producto = b.id_variante_producto
        `,
        [lowStock, stagnantDays, highRotation]
      );

      const kpi = rows[0] || {};
      res.json({
        params: {
          low_stock: lowStock,
          stagnant_days: stagnantDays,
          high_rotation: highRotation
        },
        data: {
          productos_totales: Number(kpi.productos_totales || 0),
          unidades_totales: Number(kpi.unidades_totales || 0),
          valor_inventario: Number(kpi.valor_inventario || 0),
          stock_bajo: Number(kpi.stock_bajo_productos || 0),
          stock_bajo_variantes: Number(kpi.stock_bajo_variantes || 0),
          productos_estancados: Number(kpi.estancados_productos || 0),
          productos_estancados_variantes: Number(kpi.estancados_variantes || 0),
          alta_rotacion: Number(kpi.alta_rotacion_productos || 0),
          alta_rotacion_variantes: Number(kpi.alta_rotacion_variantes || 0)
        }
      });
    } catch (err) { next(err); }
  }
);

/**
 * 11) KPIs de Despachos (Salidas de inventario)
 * GET /api/reports/movimientos/kpis?from=&to=
 */
router.get('/reports/movimientos/kpis',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);

      const conds = [`m.tipo = 'salida'`];
      const params = [];
      let i = 1;

      if (from) { conds.push(`m.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to) { conds.push(`m.created_at < ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const { rows } = await pool.query(
        `
        SELECT
          COUNT(*)::int AS total_movimientos,
          COALESCE(SUM(m.cantidad),0)::int AS total_unidades,
          COALESCE(SUM(m.cantidad * m.costo_unitario),0)::float AS valor_estimado_despachado
        FROM public.movimiento_inventario m
        ${where}
        `,
        params
      );

      res.json(rows[0] || { total_movimientos: 0, total_unidades: 0, valor_estimado_despachado: 0 });
    } catch (err) { next(err); }
  }
);

/**
 * 12) Historial Detallado de Salidas
 * GET /api/reports/movimientos/detalle?from=&to=
 */
router.get('/reports/movimientos/detalle',
  requireAuth, requireRole('admin', 'manager'),
  async (req, res, next) => {
    try {
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);

      const conds = [`m.tipo = 'salida'`];
      const params = [];
      let i = 1;

      if (from) { conds.push(`m.created_at >= $${i++}::timestamptz`); params.push(from); }
      if (to) { conds.push(`m.created_at < ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const { rows } = await pool.query(
        `
        SELECT
          m.id_movimiento_inventario AS id_salida,
          m.created_at AS fecha,
          p.nombre AS producto,
          v.sku,
          m.cantidad,
          m.motivo,
          m.ref_externa AS referencia,
          u.nombre AS autorizado_por,
          COALESCE(m.costo_unitario,0)::float AS costo_unit,
          COALESCE(m.cantidad * m.costo_unitario, 0)::float AS subtotal
        FROM public.movimiento_inventario m
        JOIN public.variante_producto v ON v.id_variante_producto = m.id_variante_producto
        JOIN public.producto p          ON p.id_producto = v.id_producto
        LEFT JOIN public.usuario u      ON u.id_usuario = m.id_usuario
        ${where}
        ORDER BY m.created_at DESC
        `,
        params
      );

      res.json({ data: rows });
    } catch (err) { next(err); }
  }
);

/**
 * DEBUG: GET /api/reports/debug/stock
 * Dumps all variants with their stock and active status.
 */
router.get('/reports/debug/stock', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
SELECT
p.id_producto,
  p.nombre AS producto,
    p.activo AS producto_activo,
      v.id_variante_producto,
      v.sku,
      v.activo AS variante_activa,
        COALESCE(i.stock, 0)::int AS stock
      FROM public.variante_producto v
      JOIN public.producto p ON p.id_producto = v.id_producto
      LEFT JOIN public.inventario i ON i.id_variante_producto = v.id_variante_producto
      ORDER BY p.id_producto, v.id_variante_producto
  `);
    res.json(rows);
  } catch (err) { next(err); }
});

/**
 * AuditorÃ­a (timeline de eventos)
 * GET /api/auditoria?target_tipo=&target_pedido_id=&target_usuario_id=&action=&actor_id=&from=&to=&page=&limit=
 * Roles:
 *   - admin/manager: ven todo
 *   - vendedor: solo eventos de inventario (INV_*)
 */
router.get('/auditoria',
  requireAuth,
  async (req, res, next) => {
    try {
      const roles = req.user?.roles || [];
      const isAdminMgr = roles.some(r => r === 'admin' || r === 'manager');
      const isVendor = roles.includes('vendedor');
      if (!isAdminMgr && !isVendor) {
        return res.status(403).json({ message: 'No autorizado' });
      }

      const target_tipo = (req.query.target_tipo || '').trim();
      const target_pedido_id = parseInt(req.query.target_pedido_id || '0', 10);
      const target_usuario_id = parseInt(req.query.target_usuario_id || '0', 10);
      const action = (req.query.action || '').trim();
      const actor_id = parseInt(req.query.actor_id || '0', 10);
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);
      const page = Math.max(1, parseInt(req.query.page || '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
      const offset = (page - 1) * limit;

      const conds = [];
      const params = [];
      let i = 1;

      if (target_tipo) { conds.push(`a.target_tipo = $${i++} `); params.push(target_tipo); }
      if (target_pedido_id) { conds.push(`a.target_pedido_id = $${i++} `); params.push(target_pedido_id); }
      if (target_usuario_id) { conds.push(`a.target_usuario_id = $${i++} `); params.push(target_usuario_id); }
      if (action) { conds.push(`a.action = $${i++} `); params.push(action); }
      if (actor_id) { conds.push(`a.actor_id = $${i++} `); params.push(actor_id); }
      if (from) { conds.push(`a.created_at >= $${i++}:: timestamptz`); params.push(from); }
      if (to) { conds.push(`a.created_at < ($${i++}:: timestamptz + INTERVAL '1 day')`); params.push(to); }

      // RestricciÃ³n: vendedores solo ven auditorÃ­a de pedidos e inventario
      if (isVendor && !isAdminMgr) {
        conds.push(`a.target_tipo = 'inventario'`);
        conds.push(`a.action LIKE 'INV_%'`);
      }

      const where = conds.length ? `WHERE ${conds.join(' AND ')} ` : '';

      const { rows: tot } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM public.auditoria a ${where} `,
        params
      );
      const total = tot[0]?.total || 0;

      const { rows } = await pool.query(
        `
SELECT
a.id,
  a.created_at,
  a.actor_id,
  ua.nombre  AS actor_nombre,
    ua.email   AS actor_email,
      a.target_tipo,
      a.target_pedido_id,
      a.target_usuario_id,
      ut.nombre  AS target_usuario_nombre,
        ut.email   AS target_usuario_email,
          p.cliente_nombre AS target_pedido_cliente,
            pr.nombre AS target_producto_nombre,
              vp.sku AS target_variante_sku,
                a.action,
                a.payload
        FROM public.auditoria a
        LEFT JOIN public.usuario ua ON ua.id_usuario = a.actor_id
        LEFT JOIN public.usuario ut ON ut.id_usuario = COALESCE(a.target_usuario_id, (a.payload ->> 'deleted_user_id'):: int)
        LEFT JOIN public.pedido p   ON p.id_pedido = a.target_pedido_id
        LEFT JOIN public.producto pr ON pr.id_producto = (a.payload ->> 'id_producto'):: int
        LEFT JOIN public.variante_producto vp ON vp.id_variante_producto = (a.payload ->> 'id_variante_producto'):: int
        ${where}
        ORDER BY a.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
`,
        params
      );

      // arma estructuras amigables para frontend
      const data = rows.map(r => ({
        id: r.id,
        created_at: r.created_at,
        actor_id: r.actor_id,
        actor_nombre: r.actor_nombre,
        actor_email: r.actor_email,
        actor: r.actor_id ? {
          id: r.actor_id,
          nombre: r.actor_nombre,
          email: r.actor_email
        } : null,
        target_tipo: r.target_tipo,
        target_pedido_id: r.target_pedido_id,
        target_usuario_id: r.target_usuario_id,
        target_usuario_nombre: r.target_usuario_nombre,
        target_usuario_email: r.target_usuario_email,
        target_pedido_cliente: r.target_pedido_cliente,
        target_producto_nombre: r.target_producto_nombre,
        target_variante_sku: r.target_variante_sku,
        target_usuario: r.target_usuario_id ? {
          id: r.target_usuario_id,
          nombre: r.target_usuario_nombre,
          email: r.target_usuario_email
        } : null,
        target_label: (() => {
          if (r.target_tipo === 'pedido' && r.target_pedido_id) return `Pedido #${r.target_pedido_id} `;

          if (r.target_tipo === 'usuario' || r.target_usuario_id) {
            const name = (r.payload?.deleted_user_nombre || r.target_usuario_nombre || r.payload?.deleted_user_id || r.target_usuario_id || '')
              .toString().replace(/ \(ELIMINADO\)$/i, '');
            return `Usuario: ${name} `;
          }

          if (r.target_tipo === 'producto' || (r.action === 'PRODUCT_SOFT_DELETE')) {
            const name = r.target_producto_nombre || r.payload?.deleted_product_nombre || r.payload?.id_producto || '';
            return `Producto: ${name} `;
          }
          if ((r.target_tipo === 'variante' || r.target_tipo === 'variante_producto' || r.target_tipo === 'inventario') && r.target_variante_sku) return `Variante: ${r.target_variante_sku} `;

          // Fallback
          const id = r.target_pedido_id || r.target_usuario_id || (r.payload?.id_producto) || (r.payload?.id_variante_producto) || (r.payload?.deleted_user_id);
          return `${r.target_tipo}${id ? ` #${id}` : ''} `;
        })(),
        action: r.action,
        action_label: ACTION_LABELS[r.action] || r.action,
        payload: r.payload,
        detail: formatDetail(r.action, r.payload)
      }));

      res.json({ data, page, limit, total });
    } catch (err) { next(err); }
  }
);

module.exports = router;





const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

function toInt(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function toNum(v, def = null) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function parseBool(v, def = false) {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'si', 'yes', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'n'].includes(s)) return false;
  return def;
}

function parseMetadata(raw) {
  if (raw === undefined) return { provided: false, value: undefined };
  if (raw === null || raw === '') return { provided: true, value: null };

  if (typeof raw === 'object') {
    return { provided: true, value: raw };
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { provided: true, value: null };
    try {
      return { provided: true, value: JSON.parse(trimmed) };
    } catch {
      throw new Error('metadata debe ser JSON valido (string JSON o objeto)');
    }
  }

  throw new Error('metadata invalida');
}

async function ensureExpenseCategoryMetadataColumn(db) {
  await db.query(`
    ALTER TABLE public.expense_category
    ADD COLUMN IF NOT EXISTS metadata JSONB;
  `);
}

function shapeExpenseCategory(row) {
  return {
    id_expense_category: row.id_expense_category,
    nombre: row.nombre,
    activo: row.activo,
    metadata: row.metadata || null,
    icon: row.metadata?.icon || null
  };
}

async function getDefaultCashBoxId(client) {
  const { rows } = await client.query(
    `SELECT id_cash_box
     FROM public.cash_box
     WHERE activo = true
     ORDER BY id_cash_box
     LIMIT 1`
  );
  return rows[0]?.id_cash_box || null;
}

router.get('/money/boxes', requireAuth, requireRole('admin', 'manager'), async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_cash_box, nombre, activo
       FROM public.cash_box
       ORDER BY nombre`
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.post('/money/boxes', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const nombre = String(req.body?.nombre || '').trim().toLowerCase();
    if (!nombre) return res.status(400).json({ message: 'nombre es requerido' });

    const { rows } = await pool.query(
      `INSERT INTO public.cash_box (nombre, activo)
       VALUES ($1, true)
       ON CONFLICT (nombre) DO UPDATE SET activo = true, updated_at = NOW()
       RETURNING id_cash_box, nombre, activo`,
      [nombre]
    );

    res.status(201).json({ message: 'Caja guardada', data: rows[0] });
  } catch (err) { next(err); }
});

router.get('/money/expense-categories', requireAuth, requireRole('admin', 'manager'), async (_req, res, next) => {
  try {
    await ensureExpenseCategoryMetadataColumn(pool);
    const { rows } = await pool.query(
      `SELECT id_expense_category, nombre, activo, metadata
       FROM public.expense_category
       ORDER BY nombre`
    );
    res.json({ data: rows.map(shapeExpenseCategory) });
  } catch (err) { next(err); }
});

router.post('/money/expense-categories', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    await ensureExpenseCategoryMetadataColumn(pool);
    const nombre = String(req.body?.nombre || '').trim().toLowerCase();
    const md = parseMetadata(req.body?.metadata);
    if (!nombre) return res.status(400).json({ message: 'nombre es requerido' });

    const { rows } = await pool.query(
      `INSERT INTO public.expense_category (nombre, activo, metadata)
       VALUES ($1, true, $2::jsonb)
       ON CONFLICT (nombre) DO UPDATE SET
         activo = true,
         metadata = COALESCE(EXCLUDED.metadata, public.expense_category.metadata),
         updated_at = NOW()
       RETURNING id_expense_category, nombre, activo, metadata`,
      [nombre, md.provided ? JSON.stringify(md.value) : null]
    );
    res.status(201).json({ message: 'Categoria guardada', data: shapeExpenseCategory(rows[0]) });
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(409).json({ message: 'Ya existe una categoria con ese nombre' });
    }
    if (String(err?.message || '').toLowerCase().includes('metadata')) {
      return res.status(400).json({ message: err.message });
    }
    return next(err);
  }
});

async function updateExpenseCategoryHandler(req, res, next) {
  try {
    await ensureExpenseCategoryMetadataColumn(pool);
    const id = toInt(req.params.id, 0);
    if (!id) return res.status(400).json({ message: 'id invalido' });

    const hasNombre = hasOwn(req.body, 'nombre');
    const hasActivo = hasOwn(req.body, 'activo');
    const md = parseMetadata(req.body?.metadata);

    if (!hasNombre && !hasActivo && !md.provided) {
      return res.status(400).json({ message: 'Debes enviar al menos un campo: nombre, metadata o activo' });
    }

    const sets = [];
    const params = [];
    let i = 1;

    if (hasNombre) {
      const nombre = String(req.body?.nombre || '').trim().toLowerCase();
      if (!nombre) return res.status(400).json({ message: 'nombre invalido' });
      sets.push(`nombre = $${i++}`);
      params.push(nombre);
    }

    if (md.provided) {
      sets.push(`metadata = $${i++}::jsonb`);
      params.push(md.value == null ? null : JSON.stringify(md.value));
    }

    if (hasActivo) {
      sets.push(`activo = $${i++}`);
      params.push(parseBool(req.body?.activo, true));
    }

    sets.push(`updated_at = NOW()`);
    params.push(id);

    const { rows } = await pool.query(
      `UPDATE public.expense_category
       SET ${sets.join(', ')}
       WHERE id_expense_category = $${i}
       RETURNING id_expense_category, nombre, activo, metadata`,
      params
    );

    if (!rows.length) return res.status(404).json({ message: 'Categoria no encontrada' });
    return res.status(200).json({ message: 'Categoria actualizada', data: shapeExpenseCategory(rows[0]) });
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(409).json({ message: 'Ya existe una categoria con ese nombre' });
    }
    if (String(err?.message || '').toLowerCase().includes('metadata')) {
      return res.status(400).json({ message: err.message });
    }
    return next(err);
  }
}

router.put('/money/expense-categories/:id', requireAuth, requireRole('admin', 'manager'), updateExpenseCategoryHandler);
router.patch('/money/expense-categories/:id', requireAuth, requireRole('admin', 'manager'), updateExpenseCategoryHandler);

router.post('/money/expenses', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const monto = toNum(req.body?.monto, NaN);
    const metodo = String(req.body?.metodo || 'efectivo').trim().toLowerCase();
    const idCategory = toInt(req.body?.id_expense_category, 0);
    const note = String(req.body?.nota || '').trim() || null;
    const refType = String(req.body?.referencia_tipo || 'gasto_manual').trim() || 'gasto_manual';
    const refId = req.body?.referencia_id != null ? String(req.body.referencia_id).trim() : null;
    let idCashBox = toInt(req.body?.id_cash_box, 0);

    if (!Number.isFinite(monto) || monto <= 0) {
      return res.status(400).json({ message: 'monto invalido' });
    }
    if (!idCategory) {
      return res.status(400).json({ message: 'id_expense_category es requerido' });
    }

    await client.query('BEGIN');

    if (!idCashBox) {
      idCashBox = await getDefaultCashBoxId(client);
    }

    const { rows: catRows } = await client.query(
      `SELECT id_expense_category
       FROM public.expense_category
       WHERE id_expense_category = $1 AND activo = true`,
      [idCategory]
    );
    if (!catRows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Categoria de gasto no existe o esta inactiva' });
    }

    const { rows } = await client.query(
      `INSERT INTO public.cash_movement
         (tipo, monto, metodo, id_expense_category, id_cash_box, referencia_tipo, referencia_id, nota, source, id_usuario)
       VALUES ('gasto', $1, $2, $3, $4, $5, $6, $7, 'manual_gasto', $8)
       RETURNING id_cash_movement, tipo, monto::float AS monto, metodo, id_expense_category, id_cash_box, referencia_tipo, referencia_id, nota, source, id_usuario, created_at`,
      [monto, metodo, idCategory, idCashBox || null, refType, refId, note, req.user.id || req.user.sub || null]
    );

    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'money', 'MONEY_EXPENSE_CREATE', $2::jsonb, NOW())`,
      [req.user.id || req.user.sub || null, JSON.stringify(rows[0])]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Gasto registrado', data: rows[0] });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    next(err);
  } finally {
    client.release();
  }
});

router.get('/money/movements', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const tipo = String(req.query.tipo || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const metodo = String(req.query.metodo || '').trim();
    const idCategory = toInt(req.query.id_expense_category, 0);
    const idCashBox = toInt(req.query.id_cash_box, 0);
    const page = Math.max(1, toInt(req.query.page, 1));
    const limit = Math.min(200, Math.max(1, toInt(req.query.limit, 25)));
    const offset = (page - 1) * limit;

    const conds = [];
    const params = [];
    let i = 1;
    if (tipo) { conds.push(`m.tipo = $${i++}`); params.push(tipo); }
    if (metodo) { conds.push(`m.metodo = $${i++}`); params.push(metodo); }
    if (idCategory) { conds.push(`m.id_expense_category = $${i++}`); params.push(idCategory); }
    if (idCashBox) { conds.push(`m.id_cash_box = $${i++}`); params.push(idCashBox); }
    if (from) { conds.push(`m.created_at >= $${i++}::timestamptz`); params.push(from); }
    if (to) { conds.push(`m.created_at < ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows: t } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM public.cash_movement m
       ${where}`,
      params
    );
    const total = t[0]?.total || 0;

    const { rows } = await pool.query(
      `SELECT
         m.id_cash_movement,
         m.tipo,
         m.monto::float AS monto,
         m.metodo,
         m.id_expense_category,
         ec.nombre AS expense_category_nombre,
         m.id_cash_box,
         cb.nombre AS cash_box_nombre,
         m.referencia_tipo,
         m.referencia_id,
         m.nota,
         m.source,
         m.id_usuario,
         u.nombre AS usuario_nombre,
         m.created_at
       FROM public.cash_movement m
       LEFT JOIN public.expense_category ec ON ec.id_expense_category = m.id_expense_category
       LEFT JOIN public.cash_box cb ON cb.id_cash_box = m.id_cash_box
       LEFT JOIN public.usuario u ON u.id_usuario = m.id_usuario
       ${where}
       ORDER BY m.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    res.json({ data: rows, page, limit, total });
  } catch (err) { next(err); }
});

router.get('/money/dashboard', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const idCashBox = toInt(req.query.id_cash_box, 0);

    const condsMov = [];
    const paramsMov = [];
    let i = 1;
    if (from) { condsMov.push(`m.created_at >= $${i++}::timestamptz`); paramsMov.push(from); }
    if (to) { condsMov.push(`m.created_at < ($${i++}::timestamptz + INTERVAL '1 day')`); paramsMov.push(to); }
    if (idCashBox) { condsMov.push(`m.id_cash_box = $${i++}`); paramsMov.push(idCashBox); }
    const whereMov = condsMov.length ? `WHERE ${condsMov.join(' AND ')}` : '';

    const { rows: movRows } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN m.tipo = 'ingreso' THEN m.monto END), 0)::float AS ingresos,
         COALESCE(SUM(CASE WHEN m.tipo = 'gasto' THEN m.monto END), 0)::float AS gastos
       FROM public.cash_movement m
       ${whereMov}`,
      paramsMov
    );
    const ingresos = Number(movRows[0]?.ingresos || 0);
    const gastos = Number(movRows[0]?.gastos || 0);

    const condsVenta = [`v.estado = 'concretada'`];
    const paramsVenta = [];
    let j = 1;
    if (from) { condsVenta.push(`v.created_at >= $${j++}::timestamptz`); paramsVenta.push(from); }
    if (to) { condsVenta.push(`v.created_at < ($${j++}::timestamptz + INTERVAL '1 day')`); paramsVenta.push(to); }
    const whereVenta = condsVenta.length ? `WHERE ${condsVenta.join(' AND ')}` : '';

    const { rows: ventaRows } = await pool.query(
      `SELECT
         COALESCE(SUM(vf.ingreso_total), 0)::float AS ventas_registradas,
         COALESCE(SUM(vf.costo_total), 0)::float AS cogs,
         COALESCE(SUM(vf.utilidad_bruta), 0)::float AS utilidad_bruta
       FROM public.venta_finanzas vf
       JOIN public.venta v ON v.id_venta = vf.id_venta
       ${whereVenta}`,
      paramsVenta
    );

    const ventasRegistradas = Number(ventaRows[0]?.ventas_registradas || 0);
    const cogs = Number(ventaRows[0]?.cogs || 0);
    const utilidadBruta = Number(ventaRows[0]?.utilidad_bruta || 0);

    const dineroCaja = ingresos - gastos;
    const gananciaReal = ingresos - gastos - cogs;

    res.json({
      filtros: {
        from: from || null,
        to: to || null,
        id_cash_box: idCashBox || null
      },
      data: {
        ingresos: Number(ingresos.toFixed(2)),
        gastos: Number(gastos.toFixed(2)),
        dinero_caja: Number(dineroCaja.toFixed(2)),
        ventas_registradas: Number(ventasRegistradas.toFixed(2)),
        cogs: Number(cogs.toFixed(2)),
        utilidad_bruta: Number(utilidadBruta.toFixed(2)),
        ganancia_real: Number(gananciaReal.toFixed(2)),
        diferencia_ventas_vs_ingresos: Number((ventasRegistradas - ingresos).toFixed(2))
      }
    });
  } catch (err) { next(err); }
});

module.exports = router;

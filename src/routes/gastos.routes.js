const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth.middleware');
const { httpError } = require('../utils/error');

const toInt = (val, def = 0) => {
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? def : parsed;
};
const round2 = (num) => Math.round((Number(num) + Number.EPSILON) * 100) / 100;

/**
 * GET /api/gastos/categorias
 */
router.get('/gastos/categorias', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_expense_category, nombre, activo, metadata, created_at, updated_at
       FROM public.expense_category
       WHERE activo = true
       ORDER BY nombre ASC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gastos/categorias
 */
router.post('/gastos/categorias', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const { nombre, metadata } = req.body;
    if (!nombre) return res.status(400).json({ message: 'El nombre es requerido' });

    const { rows } = await pool.query(
      `INSERT INTO public.expense_category (nombre, metadata, activo)
       VALUES ($1, $2, true)
       RETURNING id_expense_category, nombre, activo, metadata, created_at, updated_at`,
      [nombre, metadata || {}]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/gastos/categorias/:id
 */
router.put('/gastos/categorias/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    const { nombre, metadata } = req.body;
    if (!nombre) return res.status(400).json({ message: 'El nombre es requerido' });

    const { rows } = await pool.query(
      `UPDATE public.expense_category
       SET nombre = $2, metadata = $3, updated_at = NOW()
       WHERE id_expense_category = $1 AND activo = true
       RETURNING id_expense_category, nombre, activo, metadata, created_at, updated_at`,
      [id, nombre, metadata || {}]
    );
    if (!rows.length) return res.status(404).json({ message: 'Categoría no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/gastos/categorias/:id
 */
router.delete('/gastos/categorias/:id', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    const { rows } = await pool.query(
      `UPDATE public.expense_category
       SET activo = false, updated_at = NOW()
       WHERE id_expense_category = $1
       RETURNING id_expense_category`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Categoría no encontrada' });
    res.json({ message: 'Categoría eliminada' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/gastos
 */
router.get('/gastos', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const page = Math.max(1, toInt(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)));
    const offset = (page - 1) * limit;

    const startDate = req.query.start_date;
    const endDate = req.query.end_date;
    const search = req.query.search;
    const idCategory = toInt(req.query.id_expense_category, 0);

    const conditions = ["t.tipo = 'egreso'"];
    const params = [];
    let paramIndex = 1;

    if (startDate) {
      conditions.push(`t.created_at >= $${paramIndex}::timestamptz`);
      params.push(startDate);
      paramIndex++;
    }
    if (endDate) {
      conditions.push(`t.created_at < ($${paramIndex}::timestamptz + INTERVAL '1 day')`);
      params.push(endDate);
      paramIndex++;
    }
    if (search) {
      conditions.push(`t.concepto ILIKE $${paramIndex}`);
      params.push(`%${search}%`);
      paramIndex++;
    }
    if (idCategory > 0) {
      conditions.push(`t.id_expense_category = $${paramIndex}`);
      params.push(idCategory);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM public.transaccion_caja t
       ${whereClause}`,
      params
    );
    const total = countRows[0].total;

    const { rows } = await pool.query(
      `SELECT 
         t.id_transaccion, 
         t.concepto, 
         t.monto_usd, 
         t.tasa_cambio, 
         t.monto_real, 
         t.anulado,
         t.created_at,
         t.id_expense_category,
         c.nombre AS cuenta_nombre,
         c.moneda AS cuenta_moneda,
         ec.nombre AS categoria_nombre,
         ec.metadata AS categoria_metadata
       FROM public.transaccion_caja t
       JOIN public.cuenta c ON c.id_cuenta = t.id_cuenta
       LEFT JOIN public.expense_category ec ON ec.id_expense_category = t.id_expense_category
       ${whereClause}
       ORDER BY t.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    res.json({ data: rows, page, limit, total });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gastos
 */
router.post('/gastos', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id_cuenta, concepto, monto_usd, tasa_cambio, id_expense_category } = req.body;
    
    if (!id_cuenta || !concepto || !monto_usd) {
      return res.status(400).json({ message: 'id_cuenta, concepto y monto_usd son requeridos' });
    }

    const valUsd = Number(monto_usd);
    const rate = Number(tasa_cambio || 1.0);
    const valReal = round2(valUsd * rate);

    if (valUsd <= 0) return res.status(400).json({ message: 'El monto_usd debe ser mayor a 0' });

    await client.query('BEGIN');

    const { rows: cRows } = await client.query(
      `SELECT id_cuenta, saldo::float AS saldo, activo 
       FROM public.cuenta 
       WHERE id_cuenta = $1 AND eliminado = false FOR UPDATE`,
      [id_cuenta]
    );
    
    if (!cRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Cuenta no encontrada' });
    }
    if (!cRows[0].activo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'La cuenta está inactiva' });
    }

    const nuevoSaldo = round2(cRows[0].saldo - valReal);
    await client.query(
      `UPDATE public.cuenta SET saldo = $2, updated_at = NOW() WHERE id_cuenta = $1`,
      [id_cuenta, nuevoSaldo]
    );

    const { rows: tRows } = await client.query(
      `INSERT INTO public.transaccion_caja 
       (id_cuenta, id_usuario, monto_usd, tasa_cambio, monto_real, tipo, concepto, id_expense_category)
       VALUES ($1, $2, $3, $4, $5, 'egreso', $6, $7)
       RETURNING id_transaccion, concepto, monto_usd, tasa_cambio, monto_real, created_at`,
      [id_cuenta, req.user.id || req.user.sub, valUsd, rate, valReal, concepto, id_expense_category || null]
    );

    await client.query('COMMIT');
    res.status(201).json(tRows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/gastos/:id/anular
 */
router.patch('/gastos/:id/anular', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: 'ID inválido' });

    await client.query('BEGIN');

    const { rows: txs } = await client.query(
      `SELECT id_transaccion, id_cuenta, monto_real, anulado, tipo, concepto
       FROM public.transaccion_caja
       WHERE id_transaccion = $1
       FOR UPDATE`,
      [id]
    );

    if (!txs.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Transacción no encontrada' });
    }
    
    const tx = txs[0];
    if (tx.tipo !== 'egreso') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Solo se pueden anular egresos operativos' });
    }
    if (tx.anulado) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'El gasto ya está anulado' });
    }

    // Revert account balance
    await client.query(
      `UPDATE public.cuenta 
       SET saldo = saldo + $2, updated_at = NOW() 
       WHERE id_cuenta = $1`,
      [tx.id_cuenta, Number(tx.monto_real)]
    );

    // Mark as annulled
    await client.query(
      `UPDATE public.transaccion_caja 
       SET anulado = true, concepto = $2
       WHERE id_transaccion = $1`,
      [id, tx.concepto + ' (Anulado)']
    );

    await client.query('COMMIT');
    res.json({ message: 'Gasto anulado y saldo restituido' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * GET /api/gastos/kpis
 */
router.get('/gastos/kpis', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const startDate = req.query.start_date;
    const endDate = req.query.end_date;
    const idCategory = toInt(req.query.id_expense_category, 0);

    const conditions = ["t.tipo = 'egreso'", "t.anulado = false", "t.concepto NOT LIKE 'Salida por anulación de venta%'"];
    const params = [];
    let paramIndex = 1;

    if (startDate) {
      conditions.push(`t.created_at >= $${paramIndex}::timestamptz`);
      params.push(startDate);
      paramIndex++;
    }
    if (endDate) {
      conditions.push(`t.created_at < ($${paramIndex}::timestamptz + INTERVAL '1 day')`);
      params.push(endDate);
      paramIndex++;
    }
    if (idCategory > 0) {
      conditions.push(`t.id_expense_category = $${paramIndex}`);
      params.push(idCategory);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Total expenses & Highest expense
    const { rows: kpis } = await pool.query(
      `SELECT 
         COALESCE(SUM(monto_usd), 0)::float AS total_gastos,
         COALESCE(MAX(monto_usd), 0)::float AS max_gasto
       FROM public.transaccion_caja t
       ${whereClause}`,
      params
    );

    // Distribution by category
    const { rows: distribution } = await pool.query(
      `SELECT 
         ec.id_expense_category,
         ec.nombre AS categoria_nombre,
         ec.metadata AS categoria_metadata,
         COALESCE(SUM(t.monto_usd), 0)::float AS monto_total,
         COUNT(t.id_transaccion)::int AS count
       FROM public.transaccion_caja t
       JOIN public.expense_category ec ON ec.id_expense_category = t.id_expense_category
       ${whereClause}
       GROUP BY ec.id_expense_category, ec.nombre, ec.metadata
       ORDER BY monto_total DESC`,
      params
    );

    res.json({
      kpis: kpis[0],
      distribution
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

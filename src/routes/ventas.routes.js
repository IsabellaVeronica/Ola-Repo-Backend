const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

function toInt(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function normEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  return s || null;
}

function normPhone(v) {
  const raw = String(v || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits || null;
}

function normCedula(v) {
  const raw = String(v || '').trim();
  if (!raw) return null;
  const clean = raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return clean || null;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
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

async function getExpenseCategoryIdByName(client, nombre) {
  const { rows } = await client.query(
    `SELECT id_expense_category
     FROM public.expense_category
     WHERE lower(nombre) = lower($1)
     LIMIT 1`,
    [nombre]
  );
  return rows[0]?.id_expense_category || null;
}

async function safeRegisterVentaFinance(client, { venta, lines, metodoPago, actorId }) {
  try {
    const costoTotal = round2(
      lines.reduce((acc, line) => acc + (line.costo == null ? 0 : Number(line.costo) * Number(line.cantidad)), 0)
    );
    const utilidadBruta = round2(Number(venta.total) - costoTotal);
    const idCashBox = await getDefaultCashBoxId(client);

    await client.query(
      `INSERT INTO public.venta_finanzas
         (id_venta, ingreso_total, costo_total, utilidad_bruta)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id_venta)
       DO UPDATE SET
         ingreso_total = EXCLUDED.ingreso_total,
         costo_total = EXCLUDED.costo_total,
         utilidad_bruta = EXCLUDED.utilidad_bruta,
         updated_at = NOW()`,
      [venta.id_venta, Number(venta.total), costoTotal, utilidadBruta]
    );

    await client.query(
      `INSERT INTO public.cash_movement
         (tipo, monto, metodo, id_cash_box, referencia_tipo, referencia_id, nota, source, id_usuario)
       VALUES ('ingreso', $1, $2, $3, 'venta', $4, $5, 'venta_auto', $6)`,
      [
        Number(venta.total),
        String(metodoPago || 'efectivo').trim().toLowerCase() || 'efectivo',
        idCashBox,
        String(venta.id_venta),
        `Ingreso automatico por venta #${venta.id_venta}`,
        actorId || null
      ]
    );
  } catch (err) {
    if (err?.code === '42P01') {
      console.warn('Modulo dinero no inicializado (falta SQL 08_dinero.sql). Se omite registro financiero automatico.');
      return;
    }
    throw err;
  }
}

async function safeRegisterVentaAnulacionFinance(client, { venta, actorId }) {
  try {
    const idCashBox = await getDefaultCashBoxId(client);
    const idExpenseCategory = await getExpenseCategoryIdByName(client, 'devolucion_venta');

    await client.query(
      `INSERT INTO public.cash_movement
         (tipo, monto, metodo, id_expense_category, id_cash_box, referencia_tipo, referencia_id, nota, source, id_usuario)
       VALUES ('gasto', $1, $2, $3, $4, 'venta_anulacion', $5, $6, 'venta_anulacion_auto', $7)`,
      [
        Number(venta.total),
        String(venta.metodo_pago || 'efectivo').trim().toLowerCase() || 'efectivo',
        idExpenseCategory,
        idCashBox,
        String(venta.id_venta),
        `Salida de caja por anulacion de venta #${venta.id_venta}`,
        actorId || null
      ]
    );
  } catch (err) {
    if (err?.code === '42P01') {
      console.warn('Modulo dinero no inicializado (falta SQL 08_dinero.sql). Se omite reverso financiero de anulacion.');
      return;
    }
    throw err;
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, 'items es requerido y no puede estar vacío');
  }

  const byVariante = new Map();
  for (let i = 0; i < items.length; i++) {
    const raw = items[i] || {};
    const idRaw = raw.id_variante_producto ?? raw.id_variante ?? raw.id;
    const id = toInt(idRaw, 0);
    const qty = toInt(raw.cantidad, 0);

    if (!id) throw httpError(400, `Item ${i + 1}: id_variante_producto inválido`);
    if (!qty || qty <= 0) throw httpError(400, `Item ${i + 1}: cantidad inválida`);

    byVariante.set(id, (byVariante.get(id) || 0) + qty);
  }

  return [...byVariante.entries()].map(([id_variante_producto, cantidad]) => ({ id_variante_producto, cantidad }));
}

async function upsertClienteByCedula(db, { cedula, nombre, email, telefono }) {
  const cedulaNorm = normCedula(cedula);
  const nombreLimpio = String(nombre || '').trim();
  const emailNorm = normEmail(email);
  const telefonoNorm = normPhone(telefono);

  if (!cedulaNorm) throw httpError(400, 'cliente_cedula es requerido');
  if (!nombreLimpio) throw httpError(400, 'cliente_nombre es requerido');

  try {
    await db.query(
      `INSERT INTO public.cliente (cedula, nombre, telefono, email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (cedula)
       DO UPDATE SET
         nombre = EXCLUDED.nombre,
         telefono = EXCLUDED.telefono,
         email = EXCLUDED.email,
         updated_at = NOW()`,
      [cedulaNorm, nombreLimpio, telefonoNorm, emailNorm]
    );
  } catch (e) {
    if (e?.code === '23505') {
      throw httpError(409, 'El teléfono o email ya están registrados en otro cliente');
    }
    throw e;
  }

  return {
    cedula: cedulaNorm,
    nombre: nombreLimpio,
    email: emailNorm,
    telefono: telefonoNorm
  };
}

async function loadLockedVariant(client, idVariante) {
  await client.query(
    `INSERT INTO public.inventario (id_variante_producto, stock)
     VALUES ($1, 0)
     ON CONFLICT (id_variante_producto) DO NOTHING`,
    [idVariante]
  );

  const { rows } = await client.query(
    `SELECT
       vp.id_variante_producto,
       vp.id_producto,
       vp.sku,
       vp.precio_lista::numeric AS precio_lista,
       vp.costo::numeric AS costo,
       vp.activo AS variante_activa,
       p.activo AS producto_activo,
       p.nombre AS nombre_producto,
       COALESCE(inv.stock, 0)::int AS stock,
       COALESCE(
         (
           SELECT ip.url
           FROM public.imagen_producto ip
           WHERE ip.id_producto = p.id_producto
             AND ip.id_variante_producto = vp.id_variante_producto
             AND ip.activo = true
           ORDER BY ip.es_principal DESC, ip.id_imagen_producto ASC
           LIMIT 1
         ),
         (
           SELECT ip.url
           FROM public.imagen_producto ip
           WHERE ip.id_producto = p.id_producto
             AND ip.id_variante_producto IS NULL
             AND ip.activo = true
           ORDER BY ip.es_principal DESC, ip.id_imagen_producto ASC
           LIMIT 1
         ),
         (
           SELECT ip.url
           FROM public.imagen_producto ip
           WHERE ip.id_producto = p.id_producto
             AND ip.activo = true
           ORDER BY ip.es_principal DESC, ip.id_imagen_producto ASC
           LIMIT 1
         )
       ) AS imagen_url
     FROM public.variante_producto vp
     JOIN public.producto p ON p.id_producto = vp.id_producto
     JOIN public.inventario inv ON inv.id_variante_producto = vp.id_variante_producto
     WHERE vp.id_variante_producto = $1
     FOR UPDATE`,
    [idVariante]
  );

  return rows[0] || null;
}

async function createVentaTx(client, {
  actorId,
  idPedido = null,
  cliente,
  items,
  metodoPago = null,
  referenciaPago = null,
  observacion = null,
  source = 'directa'
}) {
  const normalizedItems = normalizeItems(items);
  const variantes = new Map();

  for (const item of normalizedItems) {
    const row = await loadLockedVariant(client, item.id_variante_producto);
    if (!row) throw httpError(404, `Variante ${item.id_variante_producto} no existe`);
    if (row.variante_activa === false || row.producto_activo === false) {
      throw httpError(400, `Variante ${item.id_variante_producto} o su producto está inactivo`);
    }
    if (row.precio_lista == null) {
      throw httpError(400, `Variante ${item.id_variante_producto} no tiene precio_lista`);
    }
    variantes.set(item.id_variante_producto, row);
  }

  for (const item of normalizedItems) {
    const v = variantes.get(item.id_variante_producto);
    if (v.stock < item.cantidad) {
      throw httpError(409, `Stock insuficiente en variante ${item.id_variante_producto} (disp: ${v.stock})`);
    }
  }

  const c = await upsertClienteByCedula(client, cliente);

  const lines = [];
  let total = 0;
  for (const item of normalizedItems) {
    const v = variantes.get(item.id_variante_producto);
    const price = Number(v.precio_lista);
    const subtotal = round2(price * item.cantidad);
    total = round2(total + subtotal);

    lines.push({
      id_variante_producto: item.id_variante_producto,
      id_producto: v.id_producto,
      nombre_producto: v.nombre_producto,
      sku: v.sku,
      cantidad: item.cantidad,
      precio_unitario: price,
      subtotal,
      costo: v.costo == null ? null : Number(v.costo),
      imagen_url: v.imagen_url || null
    });
  }

  const { rows: ventaRows } = await client.query(
    `INSERT INTO public.venta
       (id_pedido, cedula_cliente, cliente_nombre, cliente_email, cliente_telefono, estado,
        metodo_pago, referencia_pago, observacion, total, id_usuario)
     VALUES ($1, $2, $3, $4, $5, 'concretada', $6, $7, $8, $9, $10)
     RETURNING id_venta, id_pedido, cedula_cliente, cliente_nombre, cliente_email, cliente_telefono,
               estado, metodo_pago, referencia_pago, observacion, total::float AS total, id_usuario,
               created_at, updated_at`,
    [
      idPedido,
      c.cedula,
      c.nombre,
      c.email,
      c.telefono,
      metodoPago || null,
      referenciaPago || null,
      observacion || null,
      total,
      actorId || null
    ]
  );
  const venta = ventaRows[0];

  for (const line of lines) {
    await client.query(
      `INSERT INTO public.venta_item
         (id_venta, id_variante_producto, nombre_producto, sku, cantidad, precio_unitario, subtotal)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        venta.id_venta,
        line.id_variante_producto,
        line.nombre_producto,
        line.sku,
        line.cantidad,
        line.precio_unitario,
        line.subtotal
      ]
    );

    await client.query(
      `UPDATE public.inventario
          SET stock = stock - $2,
              updated_at = NOW()
        WHERE id_variante_producto = $1`,
      [line.id_variante_producto, line.cantidad]
    );

    await client.query(
      `INSERT INTO public.movimiento_inventario
         (id_variante_producto, tipo, cantidad, motivo, ref_externa, costo_unitario, id_usuario)
       VALUES ($1, 'salida', $2, $3, $4, $5, $6)`,
      [
        line.id_variante_producto,
        line.cantidad,
        `Venta #${venta.id_venta}`,
        `VTA-${venta.id_venta}`,
        line.costo,
        actorId || null
      ]
    );
  }

  if (idPedido) {
    await client.query(
      `UPDATE public.pedido
          SET estado = 'concretado',
              updated_at = NOW()
        WHERE id_pedido = $1`,
      [idPedido]
    );
  }

  await safeRegisterVentaFinance(client, {
    venta,
    lines,
    metodoPago,
    actorId
  });

  await client.query(
    `INSERT INTO public.auditoria (actor_id, target_pedido_id, target_tipo, action, payload, created_at)
     VALUES ($1, $2, 'venta', 'VENTA_CREAR', $3::jsonb, NOW())`,
    [
      actorId || null,
      idPedido,
      JSON.stringify({
        id_venta: venta.id_venta,
        source,
        total,
        items: lines.map(l => ({
          id_variante_producto: l.id_variante_producto,
          cantidad: l.cantidad,
          precio_unitario: l.precio_unitario,
          subtotal: l.subtotal
        }))
      })
    ]
  );

  return {
    ...venta,
    items: lines
  };
}

/**
 * POST /api/ventas
 * Crea venta directa y descuenta inventario.
 */
router.post('/ventas', requireAuth, requireRole('admin', 'manager', 'vendedor'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      items,
      cliente_cedula,
      cedula,
      cliente_nombre,
      cliente_email,
      cliente_telefono,
      metodo_pago,
      referencia_pago,
      observacion
    } = req.body || {};

    await client.query('BEGIN');

    const venta = await createVentaTx(client, {
      actorId: req.user.id || req.user.sub,
      cliente: {
        cedula: cliente_cedula ?? cedula,
        nombre: cliente_nombre,
        email: cliente_email,
        telefono: cliente_telefono
      },
      items,
      metodoPago: metodo_pago,
      referenciaPago: referencia_pago,
      observacion,
      source: 'directa'
    });

    await client.query('COMMIT');
    res.status(201).json({ message: 'Venta creada', venta });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    if (err.status) return res.status(err.status).json({ message: err.message });
    if (err.code === '23505') return res.status(409).json({ message: 'Conflicto de unicidad al crear venta' });
    next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /api/ventas/from-pedido/:id
 * Convierte pedido a venta y descuenta inventario.
 */
router.post('/ventas/from-pedido/:id', requireAuth, requireRole('admin', 'manager', 'vendedor'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const idPedido = toInt(req.params.id, 0);
    if (!idPedido) return res.status(400).json({ message: 'id_pedido inválido' });

    await client.query('BEGIN');

    const { rows: existingVenta } = await client.query(
      `SELECT id_venta FROM public.venta WHERE id_pedido = $1 LIMIT 1`,
      [idPedido]
    );
    if (existingVenta.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: 'Este pedido ya fue convertido a venta',
        id_venta: existingVenta[0].id_venta
      });
    }

    const { rows: pedidos } = await client.query(
      `SELECT id_pedido, cedula_cliente, cliente_nombre, cliente_email, cliente_telefono, observacion, estado
       FROM public.pedido
       WHERE id_pedido = $1
       FOR UPDATE`,
      [idPedido]
    );
    if (!pedidos.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Pedido no encontrado' });
    }
    const pedido = pedidos[0];
    if (pedido.estado === 'cancelado') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'No se puede convertir un pedido cancelado' });
    }

    const { rows: pedidoItems } = await client.query(
      `SELECT id_variante_producto, cantidad
       FROM public.pedido_item
       WHERE id_pedido = $1
       ORDER BY id_pedido_item`,
      [idPedido]
    );
    if (!pedidoItems.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'El pedido no tiene items' });
    }

    const venta = await createVentaTx(client, {
      actorId: req.user.id || req.user.sub,
      idPedido,
      cliente: {
        cedula: pedido.cedula_cliente,
        nombre: pedido.cliente_nombre,
        email: pedido.cliente_email,
        telefono: pedido.cliente_telefono
      },
      items: pedidoItems,
      metodoPago: req.body?.metodo_pago || null,
      referenciaPago: req.body?.referencia_pago || null,
      observacion: req.body?.observacion || pedido.observacion || null,
      source: 'pedido'
    });

    await client.query('COMMIT');
    res.status(201).json({ message: 'Pedido convertido a venta', venta });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    if (err.status) return res.status(err.status).json({ message: err.message });
    if (err.code === '23505') return res.status(409).json({ message: 'Este pedido ya tiene una venta asociada' });
    next(err);
  } finally {
    client.release();
  }
});

/**
 * GET /api/ventas
 * Listado de ventas.
 */
router.get('/ventas', requireAuth, requireRole('admin', 'manager', 'vendedor'), async (req, res, next) => {
  try {
    const estado = String(req.query.estado || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const search = String(req.query.search || '').trim();
    const page = Math.max(1, toInt(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)));
    const offset = (page - 1) * limit;

    const conds = [];
    const params = [];
    let i = 1;

    if (estado) { conds.push(`v.estado = $${i++}`); params.push(estado); }
    if (from) { conds.push(`v.created_at >= $${i++}::timestamptz`); params.push(from); }
    if (to) { conds.push(`v.created_at < ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
    if (search) {
      conds.push(`(v.cliente_nombre ILIKE $${i} OR v.cliente_email ILIKE $${i} OR v.cedula_cliente ILIKE $${i} OR COALESCE(v.referencia_pago, '') ILIKE $${i})`);
      params.push(`%${search}%`);
      i++;
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows: t } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM public.venta v ${where}`,
      params
    );
    const total = t[0]?.total || 0;

    const { rows } = await pool.query(
      `SELECT
         v.id_venta,
         v.id_pedido,
         v.cedula_cliente,
         v.cliente_nombre,
         v.cliente_email,
         v.cliente_telefono,
         v.estado,
         v.metodo_pago,
         v.referencia_pago,
         v.total::float AS total,
         v.id_usuario,
         u.nombre AS usuario_nombre,
         COALESCE((SELECT SUM(vi.cantidad)::int FROM public.venta_item vi WHERE vi.id_venta = v.id_venta), 0) AS total_items,
         v.created_at,
         v.updated_at
       FROM public.venta v
       LEFT JOIN public.usuario u ON u.id_usuario = v.id_usuario
       ${where}
       ORDER BY v.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    res.json({ data: rows, page, limit, total });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ventas/catalogo
 * Lista variantes vendibles con stock, precio e imagen.
 */
router.get('/ventas/catalogo', requireAuth, requireRole('admin', 'manager', 'vendedor'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, toInt(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)));
    const offset = (page - 1) * limit;
    const includeNoStock = String(req.query.include_no_stock || '').toLowerCase() === 'true';

    const conds = [
      `p.eliminado = false`,
      `p.activo = true`,
      `vp.activo = true`
    ];
    const params = [];
    let i = 1;

    if (q) {
      conds.push(`(p.nombre ILIKE $${i} OR COALESCE(vp.sku, '') ILIKE $${i})`);
      params.push(`%${q}%`);
      i++;
    }

    if (!includeNoStock) {
      conds.push(`COALESCE(inv.stock, 0) > 0`);
    }

    const where = `WHERE ${conds.join(' AND ')}`;

    const { rows: t } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM public.variante_producto vp
       JOIN public.producto p ON p.id_producto = vp.id_producto
       LEFT JOIN public.inventario inv ON inv.id_variante_producto = vp.id_variante_producto
       ${where}`,
      params
    );
    const total = t[0]?.total || 0;

    const { rows } = await pool.query(
      `SELECT
         vp.id_variante_producto,
         vp.id_producto,
         p.nombre AS nombre_producto,
         vp.sku,
         vp.atributos_json,
         vp.precio_lista::float AS precio_lista,
         COALESCE(inv.stock, 0)::int AS stock,
         COALESCE(
           (
             SELECT ip.url
             FROM public.imagen_producto ip
             WHERE ip.id_producto = p.id_producto
               AND ip.id_variante_producto = vp.id_variante_producto
               AND ip.activo = true
             ORDER BY ip.es_principal DESC, ip.id_imagen_producto ASC
             LIMIT 1
           ),
           (
             SELECT ip.url
             FROM public.imagen_producto ip
             WHERE ip.id_producto = p.id_producto
               AND ip.id_variante_producto IS NULL
               AND ip.activo = true
             ORDER BY ip.es_principal DESC, ip.id_imagen_producto ASC
             LIMIT 1
           ),
           (
             SELECT ip.url
             FROM public.imagen_producto ip
             WHERE ip.id_producto = p.id_producto
               AND ip.activo = true
             ORDER BY ip.es_principal DESC, ip.id_imagen_producto ASC
             LIMIT 1
           )
         ) AS imagen_url
       FROM public.variante_producto vp
       JOIN public.producto p ON p.id_producto = vp.id_producto
       LEFT JOIN public.inventario inv ON inv.id_variante_producto = vp.id_variante_producto
       ${where}
       ORDER BY p.nombre ASC, vp.id_variante_producto ASC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    res.json({ data: rows, page, limit, total });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ventas/:id
 * Detalle de una venta.
 */
router.get('/ventas/:id', requireAuth, requireRole('admin', 'manager', 'vendedor'), async (req, res, next) => {
  try {
    const idVenta = toInt(req.params.id, 0);
    if (!idVenta) return res.status(400).json({ message: 'id_venta inválido' });

    const { rows: head } = await pool.query(
      `SELECT
         v.id_venta,
         v.id_pedido,
         v.cedula_cliente,
         v.cliente_nombre,
         v.cliente_email,
         v.cliente_telefono,
         v.estado,
         v.metodo_pago,
         v.referencia_pago,
         v.observacion,
         v.total::float AS total,
         v.id_usuario,
         u.nombre AS usuario_nombre,
         v.created_at,
         v.updated_at
       FROM public.venta v
       LEFT JOIN public.usuario u ON u.id_usuario = v.id_usuario
       WHERE v.id_venta = $1`,
      [idVenta]
    );
    if (!head.length) return res.status(404).json({ message: 'Venta no encontrada' });

    const { rows: items } = await pool.query(
      `SELECT
         vi.id_venta_item,
         vi.id_variante_producto,
         vi.nombre_producto,
         vi.sku,
         vi.cantidad,
         vi.precio_unitario::float AS precio_unitario,
         vi.subtotal::float AS subtotal,
         COALESCE(
           (
             SELECT ip.url
             FROM public.imagen_producto ip
             JOIN public.variante_producto vp2 ON vp2.id_variante_producto = vi.id_variante_producto
             WHERE ip.id_producto = vp2.id_producto
               AND ip.id_variante_producto = vi.id_variante_producto
               AND ip.activo = true
             ORDER BY ip.es_principal DESC, ip.id_imagen_producto ASC
             LIMIT 1
           ),
           (
             SELECT ip.url
             FROM public.imagen_producto ip
             JOIN public.variante_producto vp2 ON vp2.id_variante_producto = vi.id_variante_producto
             WHERE ip.id_producto = vp2.id_producto
               AND ip.id_variante_producto IS NULL
               AND ip.activo = true
             ORDER BY ip.es_principal DESC, ip.id_imagen_producto ASC
             LIMIT 1
           )
         ) AS imagen_url
       FROM public.venta_item vi
       WHERE vi.id_venta = $1
       ORDER BY vi.id_venta_item`,
      [idVenta]
    );

    res.json({ ...head[0], items });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/ventas/:id/anular
 * Revierte stock y anula venta.
 */
router.patch('/ventas/:id/anular', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const idVenta = toInt(req.params.id, 0);
    if (!idVenta) return res.status(400).json({ message: 'id_venta inválido' });

    await client.query('BEGIN');

    const { rows: ventas } = await client.query(
      `SELECT id_venta, id_pedido, estado, total, metodo_pago
       FROM public.venta
       WHERE id_venta = $1
       FOR UPDATE`,
      [idVenta]
    );
    if (!ventas.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Venta no encontrada' });
    }
    const venta = ventas[0];
    if (venta.estado === 'anulada') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'La venta ya está anulada' });
    }

    const { rows: items } = await client.query(
      `SELECT
         vi.id_variante_producto,
         vi.cantidad,
         vp.costo::numeric AS costo_actual
       FROM public.venta_item vi
       LEFT JOIN public.variante_producto vp ON vp.id_variante_producto = vi.id_variante_producto
       WHERE vi.id_venta = $1
       ORDER BY vi.id_venta_item`,
      [idVenta]
    );
    if (!items.length) throw httpError(400, 'La venta no tiene items para anular');

    for (const item of items) {
      await client.query(
        `INSERT INTO public.inventario (id_variante_producto, stock)
         VALUES ($1, 0)
         ON CONFLICT (id_variante_producto) DO NOTHING`,
        [item.id_variante_producto]
      );

      await client.query(
        `SELECT id_variante_producto
         FROM public.inventario
         WHERE id_variante_producto = $1
         FOR UPDATE`,
        [item.id_variante_producto]
      );

      await client.query(
        `UPDATE public.inventario
            SET stock = stock + $2,
                updated_at = NOW()
          WHERE id_variante_producto = $1`,
        [item.id_variante_producto, item.cantidad]
      );

      await client.query(
        `INSERT INTO public.movimiento_inventario
           (id_variante_producto, tipo, cantidad, motivo, ref_externa, costo_unitario, id_usuario)
         VALUES ($1, 'entrada', $2, $3, $4, $5, $6)`,
        [
          item.id_variante_producto,
          item.cantidad,
          `Anulación de venta #${idVenta}`,
          `ANUL-VTA-${idVenta}`,
          item.costo_actual == null ? null : Number(item.costo_actual),
          req.user.id || req.user.sub
        ]
      );
    }

    await client.query(
      `UPDATE public.venta
          SET estado = 'anulada',
              updated_at = NOW()
        WHERE id_venta = $1`,
      [idVenta]
    );

    await safeRegisterVentaAnulacionFinance(client, {
      venta,
      actorId: req.user.id || req.user.sub
    });

    if (venta.id_pedido) {
      await client.query(
        `UPDATE public.pedido
            SET estado = 'cancelado',
                updated_at = NOW()
          WHERE id_pedido = $1`,
        [venta.id_pedido]
      );
    }

    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_pedido_id, target_tipo, action, payload, created_at)
       VALUES ($1, $2, 'venta', 'VENTA_ANULAR', $3::jsonb, NOW())`,
      [
        req.user.id || req.user.sub,
        venta.id_pedido || null,
        JSON.stringify({ id_venta: idVenta, motivo: req.body?.motivo || null })
      ]
    );

    await client.query('COMMIT');
    res.json({ message: 'Venta anulada correctamente', id_venta: idVenta });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    if (err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;

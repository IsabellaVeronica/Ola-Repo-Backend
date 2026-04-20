const { Router } = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

const MAX_IMPORT_ROWS = 5000;

const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const lower = String(file?.originalname || '').toLowerCase();
    if (lower.endsWith('.xlsx')) return cb(null, true);
    return cb(new Error('Solo se permiten archivos .xlsx'));
  }
});

function normalizeHeader(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeText(value) {
  return String(value || '').trim();
}

function parseBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'si', 'yes', 'y'].includes(v)) return true;
  if (['false', '0', 'no', 'n'].includes(v)) return false;
  return fallback;
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function parseInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n)) return NaN;
  return n;
}

function parseAttributes(rawAttributes, rawAttributesJson) {
  if (rawAttributesJson) {
    const parsed = JSON.parse(rawAttributesJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    throw new Error('atributos_json debe ser un objeto JSON');
  }

  const txt = normalizeText(rawAttributes);
  if (!txt) return null;

  const attrs = {};
  for (const piece of txt.split(/[;|]+/)) {
    const cleaned = normalizeText(piece);
    if (!cleaned) continue;
    const idx = cleaned.indexOf('=');
    const idx2 = cleaned.indexOf(':');
    const splitAt = idx >= 0 ? idx : idx2;
    if (splitAt < 0) continue;
    const key = normalizeText(cleaned.slice(0, splitAt));
    const value = normalizeText(cleaned.slice(splitAt + 1));
    if (!key) continue;
    attrs[key] = value;
  }

  return Object.keys(attrs).length ? attrs : null;
}

function pickValue(row, aliases) {
  for (const alias of aliases) {
    if (row[alias] !== undefined) return row[alias];
  }
  return undefined;
}

function normalizeSheetRows(rawRows) {
  return rawRows.map((raw) => {
    const normalized = {};
    for (const [k, v] of Object.entries(raw || {})) {
      normalized[normalizeHeader(k)] = v;
    }
    return normalized;
  });
}

function generateSku(seq) {
  const padded = String(seq).padStart(3, '0');
  return `SKU-${padded}`;
}

async function ensureVariantSkuSeq(client) {
  await client.query(`
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
  `);
}

async function nextSku(client) {
  const { rows } = await client.query(`SELECT nextval('public.variant_sku_seq') AS seq`);
  return generateSku(rows[0].seq);
}

async function getOrCreateCategory(client, cache, name) {
  const key = normalizeHeader(name);
  if (cache.has(key)) return cache.get(key);

  const cleanName = normalizeText(name);
  const { rows: found } = await client.query(
    `SELECT id_categoria, activo, eliminado
       FROM public.categoria
      WHERE lower(trim(nombre)) = lower(trim($1))
      ORDER BY id_categoria
      LIMIT 1`,
    [cleanName]
  );

  if (found.length) {
    if (found[0].activo === false || found[0].eliminado === true) {
      await client.query(
        `UPDATE public.categoria
            SET activo = true,
                eliminado = false
          WHERE id_categoria = $1`,
        [found[0].id_categoria]
      );
    }
    cache.set(key, found[0].id_categoria);
    return found[0].id_categoria;
  }

  const { rows: inserted } = await client.query(
    `INSERT INTO public.categoria (nombre, activo, eliminado)
     VALUES ($1, true, false)
     RETURNING id_categoria`,
    [cleanName]
  );
  cache.set(key, inserted[0].id_categoria);
  return inserted[0].id_categoria;
}

async function getOrCreateBrand(client, cache, name) {
  const key = normalizeHeader(name);
  if (cache.has(key)) return cache.get(key);

  const cleanName = normalizeText(name);
  const { rows: found } = await client.query(
    `SELECT id_marca, activo, eliminado
       FROM public.marca
      WHERE lower(trim(nombre)) = lower(trim($1))
      ORDER BY id_marca
      LIMIT 1`,
    [cleanName]
  );

  if (found.length) {
    if (found[0].activo === false || found[0].eliminado === true) {
      await client.query(
        `UPDATE public.marca
            SET activo = true,
                eliminado = false
          WHERE id_marca = $1`,
        [found[0].id_marca]
      );
    }
    cache.set(key, found[0].id_marca);
    return found[0].id_marca;
  }

  const { rows: inserted } = await client.query(
    `INSERT INTO public.marca (nombre, activo, eliminado)
     VALUES ($1, true, false)
     RETURNING id_marca`,
    [cleanName]
  );
  cache.set(key, inserted[0].id_marca);
  return inserted[0].id_marca;
}

async function resolveProductId({
  client,
  row,
  rowNum,
  productCache,
  categoryCache,
  brandCache
}) {
  if (row.id_producto != null) {
    const { rows: productRows } = await client.query(
      `SELECT id_producto, activo
         FROM public.producto
        WHERE id_producto = $1
          AND eliminado = false`,
      [row.id_producto]
    );
    if (!productRows.length) {
      const e = new Error(`Fila ${rowNum}: id_producto ${row.id_producto} no existe o está eliminado`);
      e.status = 400;
      throw e;
    }
    if (productRows[0].activo === false && row.activo_producto === true) {
      await client.query(
        `UPDATE public.producto
            SET activo = true
          WHERE id_producto = $1`,
        [row.id_producto]
      );
    }
    return productRows[0].id_producto;
  }

  const categoryId = await getOrCreateCategory(client, categoryCache, row.categoria);
  const brandId = await getOrCreateBrand(client, brandCache, row.marca);

  const cacheKey = row.producto_ref
    ? `ref:${normalizeHeader(row.producto_ref)}`
    : `auto:${categoryId}:${brandId}:${normalizeHeader(row.producto_nombre)}`;

  if (productCache.has(cacheKey)) return productCache.get(cacheKey);

  const { rows: existing } = await client.query(
    `SELECT id_producto, activo
       FROM public.producto
      WHERE id_categoria = $1
        AND id_marca = $2
        AND lower(trim(nombre)) = lower(trim($3))
        AND eliminado = false
      ORDER BY id_producto
      LIMIT 1`,
    [categoryId, brandId, row.producto_nombre]
  );

  if (existing.length) {
    if (existing[0].activo === false && row.activo_producto === true) {
      await client.query(
        `UPDATE public.producto
            SET activo = true
          WHERE id_producto = $1`,
        [existing[0].id_producto]
      );
    }
    productCache.set(cacheKey, existing[0].id_producto);
    return existing[0].id_producto;
  }

  const { rows: inserted } = await client.query(
    `INSERT INTO public.producto
      (id_categoria, id_marca, nombre, descripcion, activo, eliminado, fecha_creacion)
     VALUES ($1, $2, $3, $4, $5, false, NOW())
     RETURNING id_producto`,
    [categoryId, brandId, row.producto_nombre, row.producto_descripcion || null, row.activo_producto]
  );

  productCache.set(cacheKey, inserted[0].id_producto);
  return inserted[0].id_producto;
}

function buildImportRows(rawRows) {
  const normalizedRows = normalizeSheetRows(rawRows);
  const parsed = [];
  const errors = [];

  for (let idx = 0; idx < normalizedRows.length; idx += 1) {
    const rowNum = idx + 2;
    const source = normalizedRows[idx];

    const idProducto = parseInteger(pickValue(source, ['id_producto', 'producto_id', 'id']));
    const productoRef = normalizeText(pickValue(source, ['producto_ref', 'ref_producto', 'referencia_producto']));
    const categoria = normalizeText(pickValue(source, ['categoria', 'category']));
    const marca = normalizeText(pickValue(source, ['marca', 'brand']));
    const productoNombre = normalizeText(pickValue(source, ['producto_nombre', 'nombre_producto', 'producto', 'nombre']));
    const productoDescripcion = normalizeText(pickValue(source, ['producto_descripcion', 'descripcion_producto', 'descripcion']));
    const varianteRaw = normalizeText(pickValue(source, ['variante', 'nombre_variante', 'variant']));
    const variante = varianteRaw || 'Estandar';
    const precioListaRaw = pickValue(source, ['precio_lista', 'precio', 'precio_venta']);
    const costoRaw = pickValue(source, ['costo', 'costo_unitario', 'cost']);
    const codigoBarras = normalizeText(pickValue(source, ['codigo_barras', 'codigo', 'barcode']));
    const stockRaw = pickValue(source, ['stock_inicial', 'stock', 'inventario_inicial']);
    const activoProductoRaw = pickValue(source, ['activo_producto']);
    const activoVarianteRaw = pickValue(source, ['activo_variante']);
    const atributosRaw = pickValue(source, ['atributos']);
    const atributosJsonRaw = pickValue(source, ['atributos_json']);

    const allEmpty =
      !productoRef &&
      !categoria &&
      !marca &&
      !productoNombre &&
      !productoDescripcion &&
      !varianteRaw &&
      (precioListaRaw === undefined || precioListaRaw === null || precioListaRaw === '') &&
      (costoRaw === undefined || costoRaw === null || costoRaw === '') &&
      !codigoBarras &&
      (stockRaw === undefined || stockRaw === null || stockRaw === '') &&
      (idProducto === null);
    if (allEmpty) continue;

    if (idProducto !== null && Number.isNaN(idProducto)) {
      errors.push(`Fila ${rowNum}: id_producto inválido`);
      continue;
    }
    if (idProducto === null && (!categoria || !marca || !productoNombre)) {
      errors.push(`Fila ${rowNum}: si no envías id_producto, debes enviar categoria, marca y producto_nombre`);
      continue;
    }

    const precioLista = parseNumber(precioListaRaw);
    if (Number.isNaN(precioLista) || (precioLista != null && precioLista < 0)) {
      errors.push(`Fila ${rowNum}: precio_lista inválido`);
      continue;
    }

    const costo = parseNumber(costoRaw);
    if (Number.isNaN(costo) || (costo != null && costo < 0)) {
      errors.push(`Fila ${rowNum}: costo inválido`);
      continue;
    }

    const stockInicial = parseInteger(stockRaw);
    if (Number.isNaN(stockInicial) || (stockInicial != null && stockInicial < 0)) {
      errors.push(`Fila ${rowNum}: stock_inicial inválido`);
      continue;
    }

    let attrs;
    try {
      attrs = parseAttributes(atributosRaw, normalizeText(atributosJsonRaw));
    } catch (e) {
      errors.push(`Fila ${rowNum}: ${e.message}`);
      continue;
    }
    if (!attrs) attrs = {};
    if (!attrs.Tipo && variante) attrs.Tipo = variante;

    parsed.push({
      row_num: rowNum,
      id_producto: idProducto,
      producto_ref: productoRef || null,
      categoria,
      marca,
      producto_nombre: productoNombre,
      producto_descripcion: productoDescripcion || null,
      precio_lista: precioLista,
      costo,
      codigo_barras: codigoBarras || null,
      stock_inicial: stockInicial ?? 0,
      activo_producto: parseBool(activoProductoRaw, true),
      activo_variante: parseBool(activoVarianteRaw, true),
      atributos_json: Object.keys(attrs).length ? attrs : null
    });
  }

  return { parsed, errors };
}

/**
 * Aplica movimiento transaccional usando TU esquema:
 * - Tabla: public.movimiento_inventario
 * - Columnas: id_usuario, ref_externa, costo_unitario
 * - Auditoría: guarda stock_antes/stock_despues en payload (no en la tabla)
 */
async function aplicarMovimiento({
  client,
  idVariante,
  tipo,
  cantidad,
  motivo,
  refExterna,
  costoUnitario,
  actorId
}) {
  // bloquea inventario de la variante
  const invRow = await client.query(
    `SELECT id_variante_producto, COALESCE(stock,0)::int AS stock
       FROM public.inventario
      WHERE id_variante_producto = $1
      FOR UPDATE`,
    [idVariante]
  );

  let stockActual;
  if (!invRow.rows.length) {
    await client.query(
      `INSERT INTO public.inventario (id_variante_producto, stock)
       VALUES ($1, 0)`,
      [idVariante]
    );
    const again = await client.query(
      `SELECT id_variante_producto, COALESCE(stock,0)::int AS stock
         FROM public.inventario
        WHERE id_variante_producto = $1
        FOR UPDATE`,
      [idVariante]
    );
    stockActual = again.rows[0].stock;
  } else {
    stockActual = invRow.rows[0].stock;
  }

  const cant = parseInt(cantidad, 10);
  if (!Number.isInteger(cant) || cant <= 0) {
    const e = new Error('Cantidad inválida'); e.status = 400; throw e;
  }
  const t = String(tipo || '').trim();

  let stockNuevo = stockActual;
  if (t === 'entrada') stockNuevo = stockActual + cant;
  else if (t === 'salida') {
    if (stockActual < cant) { const e = new Error(`Stock insuficiente (disp: ${stockActual})`); e.status = 409; throw e; }
    stockNuevo = stockActual - cant;
  } else if (t === 'ajuste') {
    // Por simplicidad: ajuste suma; si quieres restar, manda motivo que incluya "negativo"
    if ((motivo || '').toLowerCase().includes('negativo')) {
      if (stockActual < cant) { const e = new Error(`Stock insuficiente para ajuste negativo (disp: ${stockActual})`); e.status = 409; throw e; }
      stockNuevo = stockActual - cant;
    } else {
      stockNuevo = stockActual + cant;
    }
  } else {
    const e = new Error('Tipo inválido'); e.status = 400; throw e;
  }

  // costo_unitario: si no lo mandan, intentamos tomar de variante_producto.costo
  let costo = null;
  if (costoUnitario != null && costoUnitario !== '') {
    const n = Number(costoUnitario);
    costo = Number.isFinite(n) ? n : null;
  } else {
    const { rows: vc } = await client.query(`SELECT costo::numeric FROM public.variante_producto WHERE id_variante_producto=$1`, [idVariante]);
    costo = vc.length ? Number(vc[0].costo) : null;
  }

  // actualiza inventario
  await client.query(
    `UPDATE public.inventario
        SET stock=$2, updated_at=NOW()
      WHERE id_variante_producto=$1`,
    [idVariante, stockNuevo]
  );

  // inserta movimiento en tu tabla
  const { rows: movRows } = await client.query(
    `INSERT INTO public.movimiento_inventario
       (id_variante_producto, tipo, cantidad, motivo, ref_externa, costo_unitario, id_usuario)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id_movimiento_inventario, created_at`,
    [idVariante, t, cant, motivo || null, refExterna || null, costo, actorId || null]
  );
  const mov = movRows[0];

  // auditoría con before/after
  await client.query(
    `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
     VALUES ($1, 'inventario', $2, $3::jsonb, NOW())`,
    [
      actorId || null,
      t === 'entrada' ? 'INV_ENTRADA' : (t === 'salida' ? 'INV_SALIDA' : 'INV_AJUSTE'),
      JSON.stringify({
        id_movimiento_inventario: mov.id_movimiento_inventario,
        id_variante_producto: idVariante,
        tipo: t,
        cantidad: cant,
        motivo: motivo || null,
        ref_externa: refExterna || null,
        costo_unitario: costo,
        stock_antes: stockActual,
        stock_despues: stockNuevo
      })
    ]
  );

  return { idMovimiento: mov.id_movimiento_inventario, stockAntes: stockActual, stockDespues: stockNuevo };
}

/**
 * POST /api/inventario/movimientos
 * Body:
 * {
 *   "id_variante_producto": 3,
 *   "tipo": "entrada|salida|ajuste",
 *   "cantidad": 2,
 *   "motivo": "Venta mostrador",
 *   "ref_externa": "PED-15",
 *   "costo_unitario": 4.50   // opcional; si falta, se toma de variante_producto.costo
 * }
 * Roles:
 *   entrada -> admin, manager
 *   salida  -> admin, manager, vendedor
 *   ajuste  -> admin, manager
 */
router.post('/inventario/movimientos', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id_variante_producto, tipo, cantidad, motivo, ref_externa, costo_unitario } = req.body || {};

    // autorización por tipo
    const roles = req.user?.roles || [];
    const canEntrada = roles.some(r => r === 'admin' || r === 'manager');
    const canSalida = roles.some(r => r === 'admin' || r === 'manager' || r === 'vendedor');
    const canAjuste = roles.some(r => r === 'admin' || r === 'manager');

    if (tipo === 'entrada' && !canEntrada) return res.status(403).json({ message: 'No autorizado (entrada)' });
    if (tipo === 'salida' && !canSalida) return res.status(403).json({ message: 'No autorizado (salida)' });
    if (tipo === 'ajuste' && !canAjuste) return res.status(403).json({ message: 'No autorizado (ajuste)' });

    const idVar = parseInt(id_variante_producto, 10);
    if (!Number.isInteger(idVar) || idVar <= 0) return res.status(400).json({ message: 'id_variante_producto inválido' });

    await client.query('BEGIN');

    // valida variante y producto activos
    const { rows: vr } = await client.query(
      `SELECT vp.id_variante_producto, vp.activo, p.activo AS prod_activo
         FROM public.variante_producto vp
         JOIN public.producto p ON p.id_producto = vp.id_producto
        WHERE vp.id_variante_producto = $1`,
      [idVar]
    );
    if (!vr.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Variante no existe' }); }
    if (vr[0].activo === false || vr[0].prod_activo === false) {
      await client.query('ROLLBACK'); return res.status(400).json({ message: 'Variante o producto inactivo' });
    }

    const result = await aplicarMovimiento({
      client,
      idVariante: idVar,
      tipo,
      cantidad,
      motivo,
      refExterna: ref_externa,
      costoUnitario: costo_unitario,
      actorId: req.user.id || req.user.sub
    });

    await client.query('COMMIT');
    res.status(201).json({
      message: 'Movimiento registrado',
      id_movimiento_inventario: result.idMovimiento,
      stock_antes: result.stockAntes,
      stock_despues: result.stockDespues
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    if (err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  } finally { client.release(); }
});

/**
 * GET /api/inventario/movimientos?tipo=&id_variante=&from=&to=&page=&limit=
 * Roles: admin, manager
 * (si quieres que vendedor vea solo 'salida', avísame y filtro)
 */
router.get('/inventario/movimientos', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const tipo = (req.query.tipo || '').trim();
    const idVar = parseInt(req.query.id_variante || '0', 10);
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conds = [];
    const params = [];
    let i = 1;

    if (tipo) { conds.push(`m.tipo = $${i++}`); params.push(tipo); }
    if (idVar) { conds.push(`m.id_variante_producto = $${i++}`); params.push(idVar); }
    if (from) { conds.push(`m.created_at >= $${i++}::timestamptz`); params.push(from); }
    if (to) { conds.push(`m.created_at < ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows: t } = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM public.movimiento_inventario m
        ${where}`,
      params
    );
    const total = t[0].total;

    const { rows: data } = await pool.query(
      `SELECT m.id_movimiento_inventario, m.id_variante_producto, m.tipo, m.cantidad,
              m.motivo, m.ref_externa, m.costo_unitario,
              m.id_usuario, u.nombre AS usuario_nombre,
              v.sku, p.nombre AS producto_nombre,
              m.created_at
         FROM public.movimiento_inventario m
         LEFT JOIN public.usuario u ON u.id_usuario = m.id_usuario
         JOIN public.variante_producto v ON v.id_variante_producto = m.id_variante_producto
         JOIN public.producto p          ON p.id_producto = v.id_producto
        ${where}
        ORDER BY m.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    res.json({ data, page, limit, total });
  } catch (err) { next(err); }
});

/** GET /api/inventario/stock/:id */
router.get('/inventario/stock/:id', requireAuth, requireRole('admin', 'manager', 'vendedor'), async (req, res, next) => {
  try {
    const idVar = parseInt(req.params.id, 10);
    if (!Number.isInteger(idVar) || idVar <= 0) return res.status(400).json({ message: 'id inválido' });
    const { rows } = await pool.query(
      `SELECT COALESCE(stock,0)::int AS stock
         FROM public.inventario
        WHERE id_variante_producto = $1`,
      [idVar]
    );
    res.json({ id_variante_producto: idVar, stock: rows.length ? rows[0].stock : 0 });
  } catch (err) { next(err); }
});

/**
 * GET /api/inventario/import/template
 * Descarga plantilla Excel para carga rápida.
 */
router.get('/inventario/import/template', requireAuth, requireRole('admin', 'manager'), async (_req, res, next) => {
  try {
    const rows = [
      {
        producto_ref: 'CAMISETA-LOGO',
        categoria: 'Ropa',
        marca: 'Banano',
        producto_nombre: 'Camiseta logo',
        producto_descripcion: 'Camiseta de algodon',
        variante: 'Rojo-M',
        precio_lista: 12.5,
        costo: 8.2,
        codigo_barras: '770100000001',
        stock_inicial: 20,
        activo_producto: true,
        activo_variante: true,
        atributos: 'Color=Rojo;Talla=M',
        atributos_json: '',
        id_producto: ''
      },
      {
        producto_ref: 'CAMISETA-LOGO',
        categoria: 'Ropa',
        marca: 'Banano',
        producto_nombre: 'Camiseta logo',
        producto_descripcion: 'Camiseta de algodon',
        variante: 'Azul-L',
        precio_lista: 13.0,
        costo: 8.5,
        codigo_barras: '770100000002',
        stock_inicial: 15,
        activo_producto: true,
        activo_variante: true,
        atributos: 'Color=Azul;Talla=L',
        atributos_json: '',
        id_producto: ''
      },
      {
        producto_ref: '',
        categoria: '',
        marca: '',
        producto_nombre: '',
        producto_descripcion: '',
        variante: 'Negro-XL',
        precio_lista: 14.0,
        costo: 9.0,
        codigo_barras: '',
        stock_inicial: 10,
        activo_producto: '',
        activo_variante: true,
        atributos: 'Color=Negro;Talla=XL',
        atributos_json: '',
        id_producto: 123
      }
    ];

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet['!cols'] = [
      { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 24 }, { wch: 30 },
      { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 12 },
      { wch: 14 }, { wch: 14 }, { wch: 28 }, { wch: 28 }, { wch: 12 }
    ];
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Inventario');

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=\"plantilla_carga_inventario.xlsx\"');
    return res.status(200).send(buffer);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/inventario/import/excel
 * FormData:
 * - file: archivo .xlsx
 */
router.post(
  '/inventario/import/excel',
  requireAuth,
  requireRole('admin', 'manager'),
  excelUpload.single('file'),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      if (!req.file) {
        return res.status(400).json({ message: 'Debes adjuntar un archivo .xlsx en el campo \"file\"' });
      }

      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const firstSheet = workbook.SheetNames[0];
      if (!firstSheet) {
        return res.status(400).json({ message: 'El archivo no tiene hojas' });
      }

      const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: '' });
      if (!rawRows.length) {
        return res.status(400).json({ message: 'La hoja esta vacia' });
      }
      if (rawRows.length > MAX_IMPORT_ROWS) {
        return res.status(400).json({ message: `Maximo ${MAX_IMPORT_ROWS} filas por importacion` });
      }

      const { parsed, errors } = buildImportRows(rawRows);
      if (!parsed.length) {
        return res.status(400).json({ message: 'No hay filas validas para importar', errors });
      }
      if (errors.length) {
        return res.status(400).json({ message: 'Archivo con errores de validacion', errors });
      }

      await client.query('BEGIN');
      await ensureVariantSkuSeq(client);

      const categoryCache = new Map();
      const brandCache = new Map();
      const productCache = new Map();

      let productsResolved = 0;
      let variantsCreated = 0;
      let stockUnits = 0;

      for (const row of parsed) {
        const idProducto = await resolveProductId({
          client,
          row,
          rowNum: row.row_num,
          productCache,
          categoryCache,
          brandCache
        });
        productsResolved += 1;

        const sku = await nextSku(client);
        const { rows: variantRows } = await client.query(
          `INSERT INTO public.variante_producto
            (id_producto, sku, precio_lista, costo, codigo_barras, atributos_json, activo)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id_variante_producto`,
          [
            idProducto,
            sku,
            row.precio_lista,
            row.costo,
            row.codigo_barras,
            row.atributos_json ? JSON.stringify(row.atributos_json) : null,
            row.activo_variante
          ]
        );
        const idVariante = variantRows[0].id_variante_producto;
        variantsCreated += 1;

        await client.query(
          `INSERT INTO public.inventario (id_variante_producto, stock)
           VALUES ($1, $2)`,
          [idVariante, row.stock_inicial]
        );
        stockUnits += row.stock_inicial;

        if (row.stock_inicial > 0) {
          await client.query(
            `INSERT INTO public.movimiento_inventario
              (id_variante_producto, tipo, cantidad, motivo, ref_externa, costo_unitario, id_usuario)
             VALUES ($1, 'entrada', $2, $3, $4, $5, $6)`,
            [
              idVariante,
              row.stock_inicial,
              'Carga inicial por Excel',
              `IMPORT_EXCEL:${req.file.originalname}`,
              row.costo,
              req.user.id || req.user.sub || null
            ]
          );
        }
      }

      await client.query(
        `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
         VALUES ($1, 'inventario', 'INVENTORY_IMPORT_EXCEL', $2::jsonb, NOW())`,
        [
          req.user.id || req.user.sub || null,
          JSON.stringify({
            archivo: req.file.originalname,
            filas: parsed.length,
            productos_resueltos: productsResolved,
            variantes_creadas: variantsCreated,
            unidades_stock_inicial: stockUnits
          })
        ]
      );

      await client.query('COMMIT');
      return res.status(201).json({
        message: 'Importacion completada',
        summary: {
          archivo: req.file.originalname,
          filas_procesadas: parsed.length,
          productos_resueltos: productsResolved,
          variantes_creadas: variantsCreated,
          unidades_stock_inicial: stockUnits
        }
      });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { }
      if (err.code === '22P02') {
        return res.status(400).json({ message: 'El archivo contiene valores invalidos' });
      }
      return next(err);
    } finally {
      client.release();
    }
  }
);

/**
 * POST /api/inventario/bulk/productos
 * Crear múltiples productos rápidamente (datos básicos solo)
 * Body:
 * {
 *   "productos": [
 *     { "nombre": "Producto 1", "descripcion": "Desc 1" },
 *     { "nombre": "Producto 2", "descripcion": "Desc 2" }
 *   ]
 * }
 * Returns:
 * {
 *   "message": "Productos creados",
 *   "session_id": "uuid", // para rastrear la sesión de edición
 *   "productos": [
 *     { "id_producto": 1, "nombre": "Producto 1", ... }
 *   ]
 * }
 */
router.post('/inventario/bulk/productos', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { productos } = req.body || {};

    if (!Array.isArray(productos) || !productos.length) {
      return res.status(400).json({ message: 'Debes enviar un array de productos' });
    }

    if (productos.length > 100) {
      return res.status(400).json({ message: 'Máximo 100 productos por batch' });
    }

    await client.query('BEGIN');
    await ensureVariantSkuSeq(client);

    // Obtener o crear categoría y marca "Sin especificar"
    let defaultCategoryId, defaultBrandId;

    // Buscar o crear categoría
    const { rows: catRows } = await client.query(
      `SELECT id_categoria FROM public.categoria WHERE nombre = 'Sin especificar' LIMIT 1`
    );
    if (catRows.length) {
      defaultCategoryId = catRows[0].id_categoria;
    } else {
      const { rows: newCat } = await client.query(
        `INSERT INTO public.categoria (nombre, activo, eliminado) VALUES ('Sin especificar', true, false) RETURNING id_categoria`
      );
      defaultCategoryId = newCat[0].id_categoria;
    }

    // Buscar o crear marca
    const { rows: bndRows } = await client.query(
      `SELECT id_marca FROM public.marca WHERE nombre = 'Sin especificar' LIMIT 1`
    );
    if (bndRows.length) {
      defaultBrandId = bndRows[0].id_marca;
    } else {
      const { rows: newBnd } = await client.query(
        `INSERT INTO public.marca (nombre, activo, eliminado) VALUES ('Sin especificar', true, false) RETURNING id_marca`
      );
      defaultBrandId = newBnd[0].id_marca;
    }

    const createdProducts = [];

    for (const p of productos) {
      const nombre = normalizeText(p.nombre);
      const descripcion = normalizeText(p.descripcion);

      if (!nombre) {
        continue; // saltea productos sin nombre
      }

      // Crear producto con categoría y marca por defecto
      const { rows: prodRows } = await client.query(
        `INSERT INTO public.producto (nombre, descripcion, id_categoria, id_marca, activo, fecha_creacion)
         VALUES ($1, $2, $3, $4, true, NOW())
         RETURNING id_producto, nombre, descripcion, activo, fecha_creacion`,
        [nombre, descripcion || null, defaultCategoryId, defaultBrandId]
      );

      const newProd = prodRows[0];

      // Crear variante estándar automática
      const sku = await nextSku(client);
      const { rows: varRows } = await client.query(
        `INSERT INTO public.variante_producto (id_producto, sku, precio_lista, atributos_json, activo)
         VALUES ($1, $2, 0, $3, true)
         RETURNING id_variante_producto, sku`,
        [newProd.id_producto, sku, JSON.stringify({ Tipo: "Estándar" })]
      );

      // Inicializar inventario
      await client.query(
        `INSERT INTO public.inventario (id_variante_producto, stock)
         VALUES ($1, 0)`,
        [varRows[0].id_variante_producto]
      );

      createdProducts.push({
        id_producto: newProd.id_producto,
        nombre: newProd.nombre,
        descripcion: newProd.descripcion,
        id_categoria: defaultCategoryId,
        id_marca: defaultBrandId,
        variante_estandar: varRows[0].id_variante_producto,
        sku: varRows[0].sku
      });
    }

    // Crear sesión de edición
    const sessionId = `edit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Guardar en auditoría para rastrear
    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'inventario', 'BULK_PRODUCTOS_CREADOS', $2::jsonb, NOW())`,
      [
        req.user.id || req.user.sub,
        JSON.stringify({
          session_id: sessionId,
          cantidad_productos: createdProducts.length,
          ids_producto: createdProducts.map(p => p.id_producto)
        })
      ]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Productos creados',
      session_id: sessionId,
      productos_creados: createdProducts.length,
      productos: createdProducts
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * GET /api/inventario/productos/:id/setup
 * Obtiene producto para la interfaz de edición en cola
 * Retorna: datos actuales + opciones de categorías/marcas
 */
router.get('/inventario/productos/:id/setup', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const idProd = parseInt(req.params.id, 10);
    if (!Number.isInteger(idProd) || idProd <= 0) {
      return res.status(400).json({ message: 'id_producto inválido' });
    }

    // Producto actual
    const { rows: prodRows } = await pool.query(
      `SELECT p.id_producto, p.nombre, p.descripcion, p.id_categoria, p.id_marca, p.activo,
              c.nombre AS category_name, m.nombre AS brand_name
         FROM public.producto p
         LEFT JOIN public.categoria c ON c.id_categoria = p.id_categoria
         LEFT JOIN public.marca m ON m.id_marca = p.id_marca
        WHERE p.id_producto = $1 AND p.eliminado = false`,
      [idProd]
    );

    if (!prodRows.length) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }

    const producto = prodRows[0];

    // Variantes del producto
    const { rows: variants } = await pool.query(
      `SELECT id_variante_producto, sku, precio_lista, codigo_barras, atributos_json, activo
         FROM public.variante_producto
        WHERE id_producto = $1
        ORDER BY id_variante_producto`,
      [idProd]
    );

    // Todas las categorías y marcas disponibles
    const { rows: categorias } = await pool.query(
      `SELECT id_categoria, nombre FROM public.categoria WHERE activo = true AND eliminado = false ORDER BY nombre`
    );

    const { rows: marcas } = await pool.query(
      `SELECT id_marca, nombre FROM public.marca WHERE activo = true AND eliminado = false ORDER BY nombre`
    );

    return res.json({
      producto,
      variantes: variants,
      opciones: {
        categorias,
        marcas
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/inventario/productos/:id/marca
 * Actualiza marca y categoría del producto
 */
router.put('/inventario/productos/:id/marca', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const idProd = parseInt(req.params.id, 10);
    if (!Number.isInteger(idProd) || idProd <= 0) {
      return res.status(400).json({ message: 'id_producto inválido' });
    }

    const { id_categoria, id_marca } = req.body || {};

    if (!id_categoria || !id_marca) {
      return res.status(400).json({ message: 'id_categoria e id_marca son requeridos' });
    }

    await client.query('BEGIN');

    // Validar que existen
    const { rows: catRows } = await client.query(
      `SELECT id_categoria FROM public.categoria WHERE id_categoria = $1 AND activo = true AND eliminado = false`,
      [id_categoria]
    );

    const { rows: marcRows } = await client.query(
      `SELECT id_marca FROM public.marca WHERE id_marca = $1 AND activo = true AND eliminado = false`,
      [id_marca]
    );

    if (!catRows.length || !marcRows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Categoría o marca inválida' });
    }

    // Actualizar
    const { rows: result } = await client.query(
      `UPDATE public.producto
       SET id_categoria = $1, id_marca = $2
       WHERE id_producto = $3
       RETURNING id_producto, id_categoria, id_marca`,
      [id_categoria, id_marca, idProd]
    );

    if (!result.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Producto no encontrado' });
    }

    // Auditoría
    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'producto', 'PRODUCT_UPDATE_MARCA', $2::jsonb, NOW())`,
      [
        req.user.id || req.user.sub,
        JSON.stringify({
          id_producto: idProd,
          id_categoria,
          id_marca
        })
      ]
    );

    await client.query('COMMIT');

    return res.json({
      message: 'Marca y categoría actualizadas',
      producto: result[0]
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /api/inventario/productos/:id/variantes
 * Agrega una nueva variante al producto
 * Body:
 * {
 *   "nombre_variante": "Rojo-M",
 *   "precio_lista": 12.50,
 *   "costo": 8.00,
 *   "codigo_barras": "123456789",
 *   "atributos": { "Color": "Rojo", "Talla": "M" },
 *   "stock_inicial": 10
 * }
 */
router.post('/inventario/productos/:id/variantes', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const idProd = parseInt(req.params.id, 10);
    if (!Number.isInteger(idProd) || idProd <= 0) {
      return res.status(400).json({ message: 'id_producto inválido' });
    }

    const {
      nombre_variante,
      precio_lista,
      costo,
      codigo_barras,
      atributos,
      stock_inicial
    } = req.body || {};

    // Validaciones
    const precioNum = parseNumber(precio_lista) || 0;
    const costoNum = parseNumber(costo) || null;
    const stockNum = parseInteger(stock_inicial) || 0;

    if (Number.isNaN(precioNum) || precioNum < 0) {
      return res.status(400).json({ message: 'Precio inválido' });
    }

    await client.query('BEGIN');

    // Validar que producto existe
    const { rows: prodRows } = await client.query(
      `SELECT id_producto FROM public.producto WHERE id_producto = $1 AND eliminado = false`,
      [idProd]
    );

    if (!prodRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Producto no encontrado' });
    }

    // Generar SKU
    await ensureVariantSkuSeq(client);
    const sku = await nextSku(client);

    // Construir atributos
    let atributosJson = null;
    if (atributos && typeof atributos === 'object') {
      const cleanAttrs = {};
      for (const [k, v] of Object.entries(atributos)) {
        const key = normalizeHeader(k);
        const val = normalizeText(v);
        if (key && val) cleanAttrs[key] = val;
      }
      if (nombre_variante && !cleanAttrs.Tipo) {
        cleanAttrs.Tipo = normalizeText(nombre_variante);
      }
      atributosJson = Object.keys(cleanAttrs).length ? cleanAttrs : null;
    } else if (nombre_variante) {
      atributosJson = { Tipo: normalizeText(nombre_variante) };
    }

    // Crear variante
    const { rows: varRows } = await client.query(
      `INSERT INTO public.variante_producto
       (id_producto, sku, precio_lista, costo, codigo_barras, atributos_json, activo)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id_variante_producto, sku, precio_lista::float`,
      [
        idProd,
        sku,
        precioNum,
        costoNum,
        normalizeText(codigo_barras) || null,
        atributosJson ? JSON.stringify(atributosJson) : null
      ]
    );

    const newVariant = varRows[0];

    // Inicializar inventario
    await client.query(
      `INSERT INTO public.inventario (id_variante_producto, stock)
       VALUES ($1, $2)`,
      [newVariant.id_variante_producto, stockNum]
    );

    // Registrar movimiento de entrada si hay stock inicial
    if (stockNum > 0) {
      await client.query(
        `INSERT INTO public.movimiento_inventario
         (id_variante_producto, tipo, cantidad, motivo, id_usuario)
         VALUES ($1, 'entrada', $2, 'Stock inicial por producto', $3)`,
        [newVariant.id_variante_producto, stockNum, req.user.id || req.user.sub || null]
      );
    }

    // Auditoría
    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
       VALUES ($1, 'variante', 'VARIANT_CREATED', $2::jsonb, NOW())`,
      [
        req.user.id || req.user.sub,
        JSON.stringify({
          id_producto: idProd,
          id_variante_producto: newVariant.id_variante_producto,
          sku: newVariant.sku,
          precio_lista: newVariant.precio_lista
        })
      ]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Variante creada',
      variante: {
        id_variante_producto: newVariant.id_variante_producto,
        sku: newVariant.sku,
        precio_lista: newVariant.precio_lista
      }
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;

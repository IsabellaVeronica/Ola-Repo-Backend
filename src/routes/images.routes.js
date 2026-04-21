const { Router } = require('express');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// --- Configuración de Cloudinary ---------------------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'products',
    allowed_formats: ['jpg', 'png', 'webp', 'gif'],
    public_id: (req, file) => {
      const idProd = req.params.id;
      return `p${idProd}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Helper para extraer public_id de una URL de Cloudinary
function getPublicIdFromUrl(url) {
  // Las URLs de Cloudinary tienen el formato: .../upload/v12345/folder/public_id.ext
  try {
    const parts = url.split('/');
    const lastPart = parts.pop(); // public_id.ext
    const folder = parts.pop(); // folder
    const publicIdWithExt = `${folder}/${lastPart}`;
    return publicIdWithExt.split('.')[0];
  } catch (e) {
    return null;
  }
}

// --- Endpoints --------------------------------------------------------

/**
 * POST /api/products/:id/images
 * Sube una o varias imágenes a Cloudinary y las registra en BD.
 */
router.post('/products/:id/images',
  requireAuth,
  requireRole('admin', 'manager'),
  upload.array('images', 10),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const idProd = parseInt(req.params.id, 10);
      if (!Number.isInteger(idProd) || idProd <= 0) return res.status(400).json({ message: 'id inválido' });
      
      const files = req.files || [];
      if (files.length === 0) return res.status(400).json({ message: 'Se requiere al menos un archivo en el campo "images"' });

      let idVariante = req.body.id_variante_producto ? parseInt(req.body.id_variante_producto, 10) : null;
      if (idVariante && isNaN(idVariante)) idVariante = null;

      await client.query('BEGIN');

      const { rows: rp } = await client.query(
        `SELECT 1 FROM public.imagen_producto WHERE id_producto = $1 AND es_principal = true AND activo = true LIMIT 1`,
        [idProd]
      );
      let yaTienePrincipal = rp.length > 0;

      const resultados = [];

      for (const file of files) {
        const url = file.path; // CloudinaryStorage guarda la URL en file.path
        
        const esPrincipal = !yaTienePrincipal;
        if (esPrincipal) yaTienePrincipal = true;

        const { rows } = await client.query(
          `INSERT INTO public.imagen_producto (id_producto, id_variante_producto, url, es_principal, activo)
           VALUES ($1, $2, $3, $4, true)
           RETURNING id_imagen_producto, id_producto, id_variante_producto, url, es_principal, activo`,
          [idProd, idVariante, url, esPrincipal]
        );
        resultados.push(rows[0]);
      }

      await client.query('COMMIT');
      res.status(201).json({ 
        message: `${files.length} imagen(es) subida(s) correctamente`, 
        images: resultados 
      });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      next(err);
    } finally { client.release(); }
  }
);

/**
 * GET /api/products/:id/images
 */
router.get('/products/:id/images',
  async (req, res, next) => {
    try {
      const idProd = parseInt(req.params.id, 10);
      if (!Number.isInteger(idProd) || idProd <= 0) return res.status(400).json({ message: 'id inválido' });

      const { rows } = await pool.query(
        `SELECT id_imagen_producto, id_producto, id_variante_producto, url, es_principal, activo
           FROM public.imagen_producto
          WHERE id_producto = $1 AND activo = true
          ORDER BY es_principal DESC, id_variante_producto NULLS FIRST, id_imagen_producto`,
        [idProd]
      );
      res.json({ data: rows });
    } catch (err) { next(err); }
  }
);

/**
 * PATCH /api/products/:id/images/:imgId/principal
 */
router.patch('/products/:id/images/:imgId/principal',
  requireAuth,
  requireRole('admin', 'manager'),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const idProd = parseInt(req.params.id, 10);
      const idImg  = parseInt(req.params.imgId, 10);
      if (!idProd || !idImg) return res.status(400).json({ message: 'ids inválidos' });

      await client.query('BEGIN');

      const { rows: chk } = await client.query(
        `SELECT id_imagen_producto FROM public.imagen_producto WHERE id_imagen_producto=$1 AND id_producto=$2 AND activo=true`,
        [idImg, idProd]
      );
      if (!chk.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Imagen no encontrada/activa' }); }

      await client.query(
        `UPDATE public.imagen_producto SET es_principal=false WHERE id_producto=$1`,
        [idProd]
      );
      await client.query(
        `UPDATE public.imagen_producto SET es_principal=true WHERE id_imagen_producto=$1`,
        [idImg]
      );

      await client.query('COMMIT');
      res.json({ message: 'Imagen establecida como principal' });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      next(err);
    } finally { client.release(); }
  }
);

/**
 * DELETE /api/products/:id/images/:imgId
 * Elimina de BD y también de Cloudinary.
 */
router.delete('/products/:id/images/:imgId',
  requireAuth,
  requireRole('admin', 'manager'),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const idProd = parseInt(req.params.id, 10);
      const idImg  = parseInt(req.params.imgId, 10);
      if (!idProd || !idImg) return res.status(400).json({ message: 'ids inválidos' });

      await client.query('BEGIN');

      const { rows } = await client.query(
        `DELETE FROM public.imagen_producto
          WHERE id_imagen_producto=$1 AND id_producto=$2
          RETURNING url`,
        [idImg, idProd]
      );
      if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Imagen no encontrada' }); }

      const imageUrl = rows[0].url;
      const publicId = getPublicIdFromUrl(imageUrl);

      if (publicId) {
        // Eliminar de Cloudinary
        await cloudinary.uploader.destroy(publicId);
      }

      await client.query('COMMIT');
      res.json({ message: 'Imagen eliminada permanentemente de la base de datos y la nube' });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      next(err);
    } finally { client.release(); }
  }
);

module.exports = router;


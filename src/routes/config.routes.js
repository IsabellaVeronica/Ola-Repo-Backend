const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
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

const iconStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'settings',
        allowed_formats: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'ico', 'svg'],
        public_id: () => `store_icon_${Date.now()}_${Math.random().toString(36).slice(2)}`
    }
});

const iconUpload = multer({
    storage: iconStorage,
    limits: { fileSize: 2 * 1024 * 1024 }
});

// Helper para extraer public_id de una URL de Cloudinary
function getPublicIdFromUrl(url) {
    if (!url) return null;
    try {
        const parts = url.split('/');
        const lastPart = parts.pop();
        const folder = parts.pop();
        return `${folder}/${lastPart.split('.')[0]}`;
    } catch (e) {
        return null;
    }
}

/**
 * 1) GET /api/settings
 * Devuelve todas las configuraciones de la tabla public.configuracion
 */
router.get('/settings', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT clave, valor FROM public.configuracion');
        const config = {};
        rows.forEach(r => { config[r.clave] = r.valor; });
        res.json(config);
    } catch (err) { next(err); }
});

/**
 * GET /api/public/settings
 */
router.get('/public/settings', async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            "SELECT clave, valor FROM public.configuracion WHERE clave IN ('tienda', 'catalogo', 'whatsapp')"
        );
        const config = {};
        rows.forEach(r => { config[r.clave] = r.valor; });
        res.json(config);
    } catch (err) { next(err); }
});

/**
 * 2) PATCH /api/settings
 */
router.patch('/settings', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
    try {
        const { clave, valor } = req.body || {};

        if (!clave || valor === undefined) {
            return res.status(400).json({ message: 'clave y valor son requeridos' });
        }

        const valorString = typeof valor === 'string' ? valor : JSON.stringify(valor);

        const { rows, rowCount } = await pool.query(
            `INSERT INTO public.configuracion (clave, valor) 
             VALUES ($1, $2::jsonb)
             ON CONFLICT (clave) 
             DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()
             RETURNING *`,
            [clave, valorString]
        );

        res.json({
            message: `Configuración '${clave}' actualizada`,
            data: rows[0]
        });
    } catch (err) {
        next(err);
    }
});

/**
 * 2.1) POST /api/settings/store-icon
 * multipart/form-data
 * field: icono (file)
 */
router.post('/settings/store-icon', requireAuth, requireRole('admin', 'manager'), iconUpload.single('icono'), async (req, res, next) => {
    const client = await pool.connect();
    let newIconUrl = null;
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'Archivo "icono" requerido' });
        }

        newIconUrl = req.file.path; // URL de Cloudinary
        const userId = req.user.id || req.user.sub;

        await client.query('BEGIN');

        const { rows: oldRows } = await client.query(
            `SELECT valor FROM public.configuracion WHERE clave = 'tienda' FOR UPDATE`
        );
        const oldIconUrl = oldRows[0]?.valor?.icono_url || null;

        const { rows } = await client.query(
            `INSERT INTO public.configuracion (clave, valor, updated_at)
             VALUES ('tienda', jsonb_build_object('icono_url', $1::text), NOW())
             ON CONFLICT (clave)
             DO UPDATE SET
               valor = COALESCE(public.configuracion.valor, '{}'::jsonb) || jsonb_build_object('icono_url', $1::text),
               updated_at = NOW()
             RETURNING clave, valor, updated_at`,
            [newIconUrl]
        );

        await client.query(
            `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
             VALUES ($1, 'configuracion', 'STORE_ICON_UPDATE', $2::jsonb, NOW())`,
            [userId, JSON.stringify({ old_icono_url: oldIconUrl, new_icono_url: newIconUrl })]
        );

        await client.query('COMMIT');

        if (oldIconUrl && oldIconUrl !== newIconUrl) {
            const oldPublicId = getPublicIdFromUrl(oldIconUrl);
            if (oldPublicId) {
                try { await cloudinary.uploader.destroy(oldPublicId); } catch (e) { }
            }
        }

        return res.status(201).json({
            message: 'Icono de tienda actualizado en Cloudinary',
            icono_url: newIconUrl,
            tienda: rows[0].valor
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { }
        if (newIconUrl) {
            const newPublicId = getPublicIdFromUrl(newIconUrl);
            if (newPublicId) {
                try { await cloudinary.uploader.destroy(newPublicId); } catch { }
            }
        }
        return next(err);
    } finally {
        client.release();
    }
});

/**
 * 3) GET /api/profile
 */
router.get('/profile', requireAuth, async (req, res, next) => {
    try {
        const userId = req.user.id || req.user.sub;
        const { rows } = await pool.query(
            'SELECT id_usuario, nombre, email, activo FROM public.usuario WHERE id_usuario = $1',
            [userId]
        );
        if (!rows.length) return res.status(404).json({ message: 'Usuario no encontrado' });
        res.json(rows[0]);
    } catch (err) { next(err); }
});

/**
 * 4) PATCH /api/profile
 */
router.patch('/profile', requireAuth, async (req, res, next) => {
    try {
        const userId = req.user.id || req.user.sub;
        const { nombre, email } = req.body || {};
        if (!nombre && !email) return res.status(400).json({ message: 'Nombre o email requeridos' });

        const fields = [];
        const params = [];
        let i = 1;

        if (nombre) { fields.push(`nombre = $${i++}`); params.push(nombre); }
        if (email) { fields.push(`email = $${i++}`); params.push(email.toLowerCase().trim()); }
        params.push(userId);

        const { rowCount } = await pool.query(
            `UPDATE public.usuario SET ${fields.join(', ')} WHERE id_usuario = $${i}`,
            params
        );

        if (!rowCount) return res.status(404).json({ message: 'Usuario no encontrado' });

        await pool.query(
            `INSERT INTO public.auditoria (actor_id, target_usuario_id, target_tipo, action, payload, created_at)
             VALUES ($1, $1, 'usuario', 'USUARIO_UPDATE_PERFIL', $2::jsonb, NOW())`,
            [userId, JSON.stringify({ nombre, email })]
        );

        res.json({ message: 'Perfil actualizado' });
    } catch (err) { next(err); }
});

/**
 * 5) PATCH /api/profile/password
 */
router.patch('/profile/password', requireAuth, async (req, res, next) => {
    try {
        const userId = req.user.id || req.user.sub;
        const { currentPassword, newPassword } = req.body || {};

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Ambas contraseñas son requeridas' });
        }

        const { rows } = await pool.query('SELECT password FROM public.usuario WHERE id_usuario = $1', [userId]);
        if (!rows.length) return res.status(404).json({ message: 'Usuario no encontrado' });

        const valid = await bcrypt.compare(currentPassword, rows[0].password);
        if (!valid) return res.status(401).json({ message: 'Contraseña actual incorrecta' });

        const hashed = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE public.usuario SET password = $1 WHERE id_usuario = $2', [hashed, userId]);

        await pool.query(
            `INSERT INTO public.auditoria (actor_id, target_usuario_id, target_tipo, action, payload, created_at)
             VALUES ($1, $1, 'usuario', 'USUARIO_UPDATE_PASSWORD', $2::jsonb, NOW())`,
            [userId, JSON.stringify({ changed_at: new Date() })]
        );

        res.json({ message: 'Contraseña actualizada exitosamente' });
    } catch (err) { next(err); }
});

module.exports = router;

const { pool } = require('./src/db/pool');
require('dotenv').config();

async function alterTable() {
    try {
        console.log('--- Alterando tabla venta ---');
        await pool.query(`
            ALTER TABLE public.venta
            ADD COLUMN IF NOT EXISTS tipo_venta VARCHAR(20) DEFAULT 'contado',
            ADD COLUMN IF NOT EXISTS total_pagado NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS estado_pago VARCHAR(20) DEFAULT 'pagado',
            ADD COLUMN IF NOT EXISTS estado_entrega VARCHAR(20) DEFAULT 'entregado';
        `);
        
        // Update existing rows to have total_pagado = total
        await pool.query(`
            UPDATE public.venta
            SET total_pagado = total
            WHERE total_pagado = 0;
        `);

        console.log('Tabla modificada con éxito.');
    } catch (e) {
        console.error('Error:', e);
    } finally {
        pool.end();
    }
}
alterTable();

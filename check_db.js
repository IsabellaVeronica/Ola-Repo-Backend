const { pool } = require('./src/db/pool');
require('dotenv').config();

async function check() {
    try {
        console.log('--- Columnas de venta, pedido, venta_finanzas ---');
        for (const table of ['venta', 'pedido', 'venta_finanzas']) {
            const { rows } = await pool.query(`
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_name = $1
                ORDER BY ordinal_position
            `, [table]);
            console.log(`\nTable: ${table}`);
            console.table(rows);
        }
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
check();

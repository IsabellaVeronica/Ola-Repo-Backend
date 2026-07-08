const { pool } = require('./src/db/pool');

async function alterDb() {
  try {
    await pool.query(`
      ALTER TABLE public.transaccion_caja 
      ADD COLUMN id_expense_category INT REFERENCES public.expense_category(id_expense_category) ON DELETE SET NULL, 
      ADD COLUMN anulado BOOLEAN DEFAULT false;
    `);
    console.log('Database altered successfully.');
  } catch (err) {
    console.error('Error altering DB:', err);
  } finally {
    pool.end();
  }
}

alterDb();

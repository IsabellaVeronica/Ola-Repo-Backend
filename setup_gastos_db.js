const { pool } = require('./src/db/pool');

async function checkAndCreate() {
  try {
    // Check if expense_category table exists
    const { rows: tableCheck } = await pool.query(`
      SELECT EXISTS(
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema='public' AND table_name='expense_category'
      ) AS exists
    `);
    
    console.log('Table expense_category exists:', tableCheck[0].exists);

    if (!tableCheck[0].exists) {
      console.log('Creating expense_category table...');
      await pool.query(`
        CREATE TABLE public.expense_category (
          id_expense_category SERIAL PRIMARY KEY,
          nombre VARCHAR(100) NOT NULL,
          activo BOOLEAN DEFAULT true,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      console.log('Table created successfully!');
    }

    // Check if transaccion_caja has id_expense_category column
    const { rows: colCheck } = await pool.query(`
      SELECT EXISTS(
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema='public' AND table_name='transaccion_caja' AND column_name='id_expense_category'
      ) AS exists
    `);
    
    console.log('Column id_expense_category in transaccion_caja exists:', colCheck[0].exists);

    if (!colCheck[0].exists) {
      console.log('Adding id_expense_category column to transaccion_caja...');
      await pool.query(`
        ALTER TABLE public.transaccion_caja 
        ADD COLUMN id_expense_category INT REFERENCES public.expense_category(id_expense_category)
      `);
      console.log('Column added successfully!');
    }

    console.log('All done!');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

checkAndCreate();

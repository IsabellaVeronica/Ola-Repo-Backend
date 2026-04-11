# Banano-Shop
Sistema de Inventario y Catalogo virtual para Banano Shop

## Configuracion Neon y Vercel

### 1) Local (backend)
1. Copia `.env.example` a `.env`.
2. Reemplaza `DATABASE_URL` por la URL de Neon (pooled, con `sslmode=require`).
3. Define `JWT_SECRET` con un valor largo y unico.
4. Ejecuta backend con `npm run dev`.
5. Verifica salud: `GET http://localhost:3001/api/health`.

### 2) Base de datos (Neon)
Si la BD de Neon esta vacia, ejecuta en orden:
1. `sql/01_auth.sql`
2. `sql/02_catalogo.sql`
3. `sql/03_inventario.sql`
4. `sql/04_pedidos.sql`
5. `sql/05_sistema.sql`
6. `sql/06_ventas.sql`
7. `sql/07_reports_optimizacion.sql`
8. `sql/08_dinero.sql`

### 3) Variables en Vercel
Si despliegas backend:
- `DATABASE_URL` = cadena Neon
- `PGSSL` = `require`
- `JWT_SECRET` = secreto unico
- `NODE_ENV` = `production`

Si despliegas frontend:
- `PUBLIC_EXTERNAL_API_BASE` = URL publica del backend + `/api`

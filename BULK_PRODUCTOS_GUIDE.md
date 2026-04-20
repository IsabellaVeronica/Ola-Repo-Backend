# Módulo de Carga Rápida y Edición en Cola de Productos

## 🎯 Flujo Completo

```
1. Crear Múltiples Productos (datos básicos)
   ↓
2. Usuario Acepta la Carga
   ↓
3. Aparece Botón "Editar Productos" 
   ↓
4. Se Muestra Primera Tarjeta (Marca, Categoría, Variantes, Imágenes)
   ↓
5. Completa Datos → SIGUIENTE 
   ↓
6. Segunda Tarjeta (igual que la anterior)
   ↓
7. ... Hasta completar todos los productos
   ↓
8. Mensaje de Éxito "¡Todos los productos están listos!"
```

## 📋 Endpoints Implementados

### 1. **POST `/api/inventario/bulk/productos`**
Crear múltiples productos en batch (datos básicos solamente).

**Request:**
```json
{
  "productos": [
    { "nombre": "Camiseta Básica", "descripcion": "Camiseta de algodón 100%" },
    { "nombre": "Pantalón Deportivo", "descripcion": "Pantalón deportivo talla única" },
    { "nombre": "Sudadera Premium", "descripcion": "" }
  ]
}
```

**Response:**
```json
{
  "message": "Productos creados",
  "session_id": "edit_1713292800123_a1b2c3d4e5",
  "productos_creados": 3,
  "productos": [
    {
      "id_producto": 45,
      "nombre": "Camiseta Básica",
      "descripcion": "Camiseta de algodón 100%",
      "id_categoria": null,
      "id_marca": null,
      "variante_estandar": 128,
      "sku": "SKU-001"
    },
    ...
  ]
}
```

---

### 2. **GET `/api/inventario/productos/:id/setup`**
Obtiene TODA la información necesaria para editar un producto en la tarjeta (interfaz de cola).

**Request:**
```
GET /api/inventario/productos/45/setup
```

**Response:**
```json
{
  "producto": {
    "id_producto": 45,
    "nombre": "Camiseta Básica",
    "descripcion": "Camiseta de algodón 100%",
    "id_categoria": null,
    "id_marca": null,
    "activo": true,
    "category_name": null,
    "brand_name": null
  },
  "variantes": [
    {
      "id_variante_producto": 128,
      "sku": "SKU-001",
      "precio_lista": 0,
      "codigo_barras": null,
      "atributos_json": { "Tipo": "Estándar" },
      "activo": true
    }
  ],
  "opciones": {
    "categorias": [
      { "id_categoria": 1, "nombre": "Ropa" },
      { "id_categoria": 2, "nombre": "Accesorios" }
    ],
    "marcas": [
      { "id_marca": 1, "nombre": "Nike" },
      { "id_marca": 2, "nombre": "Adidas" }
    ]
  }
}
```

---

### 3. **PUT `/api/inventario/productos/:id/marca`**
Actualiza la marca y categoría del producto.

**Request:**
```json
{
  "id_categoria": 1,
  "id_marca": 2
}
```

**Response:**
```json
{
  "message": "Marca y categoría actualizadas",
  "producto": {
    "id_producto": 45,
    "id_categoria": 1,
    "id_marca": 2
  }
}
```

---

### 4. **POST `/api/inventario/productos/:id/variantes`**
Agregara una nueva variante al producto (ej: talla/color diferente).

**Request:**
```json
{
  "nombre_variante": "Rojo-M",
  "precio_lista": 12.50,
  "costo": 8.00,
  "codigo_barras": "123456789",
  "atributos": {
    "Color": "Rojo",
    "Talla": "M"
  },
  "stock_inicial": 10
}
```

**Response:**
```json
{
  "message": "Variante creada",
  "variante": {
    "id_variante_producto": 129,
    "sku": "SKU-002",
    "precio_lista": 12.5
  }
}
```

---

## 🎨 Estructura de la Interfaz de Cola (Frontend)

```html
<!-- PASO 1: Formulario de Carga Rápida -->
<div class="quick-load-form">
  <input placeholder="Nombre Producto 1">
  <input placeholder="Descripción (opcional)">
  <button>+ Agregar otro</button>
  <button class="primary">Cargar Productos</button>
</div>

<!-- PASO 2: Después de cargar - Ver resumen -->
<div class="load-summary">
  <h2>✓ Se crearon 3 productos</h2>
  <button class="primary">Editar Productos en Cola</button>
</div>

<!-- PASO 3: Interfaz de edición en cola (MODAL/TARJETA) -->
<div class="queue-editor">
  <div class="queue-header">
    <h2>Completar Producto 1 de 3</h2>
    <div class="progress-bar" style="width: 33%"></div>
  </div>

  <!-- TARJETA ACTUAL -->
  <div class="product-card">
    
    <!-- Sección 1: Marca y Categoría -->
    <div class="section">
      <h3>📦 Marca y Categoría</h3>
      <select id="categoria" required>
        <option>-- Selecciona Categoría --</option>
        <option value="1">Ropa</option>
        <option value="2">Accesorios</option>
      </select>
      
      <select id="marca" required>
        <option>-- Selecciona Marca --</option>
        <option value="1">Nike</option>
        <option value="2">Adidas</option>
      </select>
    </div>

    <!-- Sección 2: Variantes y Precios -->
    <div class="section">
      <h3>📊 Variantes y Precios</h3>
      
      <!-- Variante estándar (siempre existe) -->
      <div class="variant-item">
        <label>Variante Estándar (SKU-001)</label>
        <input type="number" placeholder="Precio Lista" id="precio_lista">
        <input type="number" placeholder="Costo" id="costo">
        <input type="number" placeholder="Stock Inicial" id="stock">
      </div>

      <!-- Agregar más variantes (ej: tallas/colores) -->
      <button class="secondary">+ Agregar otra variante</button>
      
      <!-- Aquí aparecen más variantes si las agrega -->
      <div class="variant-form" style="display:none">
        <input placeholder="Nombre (ej: Rojo-M)">
        <input type="number" placeholder="Precio">
        <input placeholder="Color">
        <input placeholder="Talla">
        <input type="number" placeholder="Stock">
        <button>Crear Variante</button>
      </div>
    </div>

    <!-- Sección 3: Imágenes -->
    <div class="section">
      <h3>🖼️ Imágenes</h3>
      <div class="image-upload">
        <input type="file" multiple accept="image/*">
        <p>Arrastra imágenes aquí o haz clic</p>
      </div>
      <div class="image-preview" id="preview"></div>
    </div>

  </div>

  <!-- Botones de Navegación -->
  <div class="queue-footer">
    <button class="secondary" onclick="previousProduct()">← Anterior</button>
    <button class="secondary" onclick="skipProduct()">Saltar</button>
    <button class="primary" onclick="nextProduct()">Siguiente →</button>
  </div>

</div>

<!-- PASO 4: Completado -->
<div class="completion-message">
  <h2>✅ ¡Todos los productos están listos!</h2>
  <p>3 productos completados correctamente</p>
  <button>Ver productos</button>
</div>
```

---

## 🔄 Flujo en el Frontend (Pseudocódigo)

```javascript
// PASO 1: Usuario crea múltiples productos rápido
async function cargarProductosRapido(productosBasicos) {
  const response = await fetch('/api/inventario/bulk/productos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productos: productosBasicos })
  });
  
  const data = await response.json();
  const sessionId = data.session_id;
  const productosIds = data.productos.map(p => p.id_producto);
  
  mostrarResumenCarga(data.productos_creados);
  guardarEnStorage({ sessionId, productosIds, indiceActual: 0 });
}

// PASO 2: Usuario hace clic en "Editar Productos"
async function entrarModoEdicionEnCola() {
  const { sessionId, productosIds, indiceActual } = recuperarDelStorage();
  
  // Cargar primer producto
  cargarProductoEnTarjeta(productosIds[indiceActual]);
}

// PASO 3: Cargar datos del producto actual
async function cargarProductoEnTarjeta(idProducto) {
  const response = await fetch(`/api/inventario/productos/${idProducto}/setup`);
  const data = await response.json();
  
  // Llenar formulario con:
  // - Dropdowns de categoría/marca
  // - Inputs de variantes y precios
  // - Área de carga de imágenes
  mostrarTarjeta(data);
}

// PASO 4: Guardar cambios y pasar al siguiente
async function completarProductoActual(datosEditados) {
  const { sessionId, productosIds, indiceActual } = recuperarDelStorage();
  const idProducto = productosIds[indiceActual];
  
  // Guardar marca y categoría
  await fetch(`/api/inventario/productos/${idProducto}/marca`, {
    method: 'PUT',
    body: JSON.stringify({
      id_categoria: datosEditados.categoria,
      id_marca: datosEditados.marca
    })
  });
  
  // Agregar variantes si hay
  if (datosEditados.nuevasVariantes) {
    for (const v of datosEditados.nuevasVariantes) {
      await fetch(`/api/inventario/productos/${idProducto}/variantes`, {
        method: 'POST',
        body: JSON.stringify(v)
      });
    }
  }
  
  // Subir imágenes (usando endpoint existente images.routes.js)
  if (datosEditados.imagenes) {
    const formData = new FormData();
    datosEditados.imagenes.forEach(img => formData.append('images', img));
    formData.append('id_producto', idProducto);
    
    await fetch('/api/productos/images', {
      method: 'POST',
      body: formData
    });
  }
  
  // Ir al siguiente
  const siguiente = indiceActual + 1;
  if (siguiente < productosIds.length) {
    guardarEnStorage({
      sessionId, productosIds, indiceActual: siguiente
    });
    cargarProductoEnTarjeta(productosIds[siguiente]);
  } else {
    mostrarMensajeExito();
  }
}

// PASO 5: Navegación
function siguientePorducto() { completarProductoActual(datosForm); }
function productoAnterior() { 
  const { indiceActual } = recuperarDelStorage();
  if (indiceActual > 0) cambiarIndice(indiceActual - 1);
}
function saltarProducto() {
  const { indiceActual } = recuperarDelStorage();
  cambiarIndice(indiceActual + 1);
}
```

---

## 📞 Flujo Completo (Usuario Side)

1. **Abre módulo "Carga Masiva de Productos"**
2. **Ingresa rápidamente:**
   - Nombre producto 1
   - Descripción (opcional)
   - Nombre producto 2
   - ...
3. **Hace clic en "CARGAR PRODUCTOS"**
   - ✅ Backend crea 3 productos vacíos
   - ✅ Se muestra: "Creados 3 productos"
   - ✅ Aparece botón: "Editar en Cola"

4. **Hace clic en "EDITAR EN COLA"**
   - Se muestra **TARJETA 1 de 3**
   - Campos a completar:
     - Selecciona Marca (dropdown)
     - Selecciona Categoría (dropdown)
     - Precio lista (variante estándar)
     - Costo
     - Stock inicial
     - Agregar más variantes (opcional): Color, Talla, etc.
     - Subir imágenes
   - Botones: "← Anterior | Saltar | Siguiente →"

5. **Hace clic en "SIGUIENTE"**
   - Se guarda todo de la tarjeta 1
   - Se muestra **TARJETA 2 de 3**
   - (mismo proceso...)

6. **Termina tarjeta 3**
   - ✅ **Mensaje final:** "¡Todos los productos están listos!"

---

## 🚀 Todo Está Listo en Backend

Los endpoints están implementados. **Solo necesitas:**

1. **Frontend:** Crear la interfaz de cola (tarjetas)
2. **Storage:** Guardar `sessionId`, `productosIds`, `indiceActual` en localStorage
3. **Imágenes:** Usar el endpoint existente `/api/productos/images`

---

## ✅ Ejemplo de Llamadas Completas

### Crear 3 productos rápido:
```bash
curl -X POST http://localhost:3000/api/inventario/bulk/productos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{
    "productos": [
      { "nombre": "Camiseta", "descripcion": "100% algodón" },
      { "nombre": "Pantalón", "descripcion": "Deportivo" },
      { "nombre": "Sudadera", "descripcion": "" }
    ]
  }'
```

### Obtener datos para editar producto 45:
```bash
curl http://localhost:3000/api/inventario/productos/45/setup \
  -H "Authorization: Bearer TOKEN"
```

### Actualizar marca del producto 45:
```bash
curl -X PUT http://localhost:3000/api/inventario/productos/45/marca \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{ "id_categoria": 1, "id_marca": 2 }'
```

### Agregar variante al producto 45:
```bash
curl -X POST http://localhost:3000/api/inventario/productos/45/variantes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{
    "nombre_variante": "Rojo-M",
    "precio_lista": 12.50,
    "costo": 8.00,
    "atributos": { "Color": "Rojo", "Talla": "M" },
    "stock_inicial": 10
  }'
```

---

## 📱 Respuestas a Errores Comunes

| Error | Cause | Solución |
|-------|-------|----------|
| 400 "id producto inválido" | ID no es número | Verifica que `id_producto` sea numérico |
| 400 "id_categoria inválida" | Categoría no existe | Primero obtén opciones con `/setup` |
| 404 "Producto no encontrado" | Producto fue eliminado | Verifica que el producto aún existe |
| 409 "Stock insuficiente" | No hay stock para salida | Solo en movimientos, no en creación |

---

## 🎯 Ventajas de Este Sistema

✅ **Carga rápida** de datos básicos sin llenar todo al principio
✅ **Edición en cola** - completa uno y pasa automáticamente al siguiente
✅ **Flexible** - saltea productos si lo necesitas
✅ **Auditoría completa** - todo queda registrado
✅ **Manejo de variantes** - agrega tallas/colores after de crear
✅ **Imágenes integradas** - sube fotos en la misma interfaz

---

Cualquier duda o cambio que necesites, solo avísame.

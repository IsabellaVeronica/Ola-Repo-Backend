/**
 * EJEMPLO DE IMPLEMENTACIÓN FRONTEND
 * Módulo de Carga en Cola de Productos
 * 
 * Este archivo muestra cómo implementar el flujo completo
 * de carga rápida y edición en cola en tu frontend
 */

// ============================================
// CONFIGURACIÓN GLOBAL
// ============================================

const API_BASE = 'http://localhost:3000/api';
const STORAGE_KEY = 'productosCola';

// ============================================
// 1. CARGAR PRODUCTOS MASIVAMENTE (RÁPIDO)
// ============================================

async function cargarProductosRapido() {
  const container = document.getElementById('quick-load-form');
  const inputs = container.querySelectorAll('.producto-row');
  
  const productos = [];
  
  inputs.forEach(row => {
    const nombre = row.querySelector('.nombre')?.value.trim();
    const descripcion = row.querySelector('.descripcion')?.value.trim();
    
    if (nombre) {
      productos.push({
        nombre,
        descripcion: descripcion || null
      });
    }
  });
  
  if (!productos.length) {
    alert('Agrega al menos un producto');
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/inventario/bulk/productos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${obtenerToken()}`
      },
      body: JSON.stringify({ productos })
    });
    
    if (!response.ok) {
      const error = await response.json();
      alert(`Error: ${error.message}`);
      return;
    }
    
    const data = await response.json();
    
    // Guardar en localStorage
    const sessionData = {
      sessionId: data.session_id,
      productosIds: data.productos.map(p => p.id_producto),
      indiceActual: 0,
      productosCargados: data.productos,
      createdAt: new Date().toISOString()
    };
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionData));
    
    // Mostrar resumen
    mostrarResumenCarga(data.productos_creados, data.productos);
    
  } catch (error) {
    console.error('Error cargando productos:', error);
    alert('Error al cargar productos');
  }
}

// ============================================
// 2. MOSTRAR RESUMEN Y OPCIÓN DE EDITAR
// ============================================

function mostrarResumenCarga(cantidad, productos) {
  // Ocultar formulario
  document.getElementById('quick-load-form').style.display = 'none';
  
  // Mostrar resumen
  const resumen = document.getElementById('load-summary');
  resumen.innerHTML = `
    <div class="summary-card">
      <div class="success-check">✓</div>
      <h2>Se crearon ${cantidad} productos</h2>
      
      <div class="productos-preview">
        ${productos.map((p, i) => `
          <div class="producto-item">
            <span class="numero">${i + 1}.</span>
            <span class="nombre">${p.nombre}</span>
          </div>
        `).join('')}
      </div>
      
      <div class="resumen-buttons">
        <button class="btn-secondary" onclick="resetearFormulario()">Cargar más</button>
        <button class="btn-primary" onclick="iniciarModoEdicionEnCola()">Editar en Cola</button>
      </div>
    </div>
  `;
  
  resumen.style.display = 'block';
}

// ============================================
// 3. INICIAR EDICIÓN EN COLA
// ============================================

async function iniciarModoEdicionEnCola() {
  const sessionData = JSON.parse(localStorage.getItem(STORAGE_KEY));
  
  if (!sessionData || !sessionData.productosIds.length) {
    alert('No hay productos para editar');
    return;
  }
  
  // Ocultar resumen, mostrar editor
  document.getElementById('load-summary').style.display = 'none';
  document.getElementById('queue-editor').style.display = 'block';
  
  // Cargar primer producto
  await cargarProductoEnTarjeta(0);
}

// ============================================
// 4. CARGAR PRODUCTO EN TARJETA (SETUP)
// ============================================

async function cargarProductoEnTarjeta(indice) {
  const sessionData = JSON.parse(localStorage.getItem(STORAGE_KEY));
  const idProducto = sessionData.productosIds[indice];
  const totalProductos = sessionData.productosIds.length;
  
  try {
    // Obtener datos del producto
    const response = await fetch(`${API_BASE}/inventario/productos/${idProducto}/setup`, {
      headers: {
        'Authorization': `Bearer ${obtenerToken()}`
      }
    });
    
    if (!response.ok) throw new Error('No se pudo cargar el producto');
    
    const data = await response.json();
    
    // Actualizar índice actual
    sessionData.indiceActual = indice;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionData));
    
    // Renderizar tarjeta
    renderizarTarjeta(data, idProducto, indice + 1, totalProductos);
    
  } catch (error) {
    console.error('Error cargando producto:', error);
    alert('Error al cargar el producto');
  }
}

// ============================================
// 5. RENDERIZAR TARJETA DE EDICIÓN
// ============================================

function renderizarTarjeta(data, idProducto, numeroActual, totalProductos) {
  const tarjeta = document.getElementById('product-card');
  
  const porcentajeProgress = (numeroActual / totalProductos) * 100;
  
  tarjeta.innerHTML = `
    <div class="queue-header">
      <h2>Completar Producto ${numeroActual} de ${totalProductos}</h2>
      <div class="progress-container">
        <div class="progress-bar" style="width: ${porcentajeProgress}%"></div>
      </div>
      <p class="progress-text">${numeroActual}/${totalProductos}</p>
    </div>
    
    <!-- SECCIÓN 1: MARCA Y CATEGORÍA -->
    <div class="section">
      <h3>📦 Marca y Categoría</h3>
      
      <div class="form-group">
        <label>Categoría *</label>
        <select id="categoria" required>
          <option value="">-- Selecciona Categoría --</option>
          ${data.opciones.categorias.map(c => `
            <option value="${c.id_categoria}" ${data.producto.id_categoria === c.id_categoria ? 'selected' : ''}>
              ${c.nombre}
            </option>
          `).join('')}
        </select>
      </div>
      
      <div class="form-group">
        <label>Marca *</label>
        <select id="marca" required>
          <option value="">-- Selecciona Marca --</option>
          ${data.opciones.marcas.map(m => `
            <option value="${m.id_marca}" ${data.producto.id_marca === m.id_marca ? 'selected' : ''}>
              ${m.nombre}
            </option>
          `).join('')}
        </select>
      </div>
    </div>
    
    <!-- SECCIÓN 2: VARIANTES Y PRECIOS -->
    <div class="section">
      <h3>📊 Variantes y Precios</h3>
      
      <div id="variantes-container">
        ${renderizarVariantes(data.variantes)}
      </div>
      
      <button type="button" class="btn-secondary" onclick="agregarFormularioVariante(${idProducto})">
        + Agregar otra variante
      </button>
      
      <div id="new-variant-form" style="display:none; margin-top: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 5px;">
        ${renderizarFormularioVariante()}
      </div>
    </div>
    
    <!-- SECCIÓN 3: IMÁGENES -->
    <div class="section">
      <h3>🖼️ Imágenes del Producto</h3>
      
      <div class="image-upload-area" id="upload-area">
        <input type="file" id="image-input" multiple accept="image/*" style="display:none;">
        <div class="upload-prompt">
          <p>📁 Arrastra imágenes aquí o haz clic</p>
          <small>PNG, JPG (máx 10 MB)</small>
        </div>
      </div>
      
      <div id="image-preview" class="image-preview"></div>
    </div>
    
    <!-- DATOS INTERNOS -->
    <input type="hidden" id="id-producto" value="${idProducto}">
  `;
  
  // Configurar eventos
  configurarEventosUpload();
  configurarEventosVariantes();
}

// ============================================
// 6. RENDERIZAR VARIANTES EXISTENTES
// ============================================

function renderizarVariantes(variantes) {
  return variantes.map((v, idx) => `
    <div class="variant-card" data-variant-id="${v.id_variante_producto}">
      <div class="variant-header">
        <strong>${v.atributos_json?.Tipo || 'Estándar'}</strong>
        <small>${v.sku}</small>
      </div>
      
      <div class="form-row">
        <div class="form-group">
          <label>Precio Lista</label>
          <input type="number" class="precio-lista" 
                 value="${v.precio_lista || 0}" 
                 step="0.01" min="0">
        </div>
        
        <div class="form-group">
          <label>Código de Barras</label>
          <input type="text" class="codigo-barras" 
                 value="${v.codigo_barras || ''}">
        </div>
      </div>
      
      <div class="form-group">
        <label>Atributos</label>
        <small>Ej: Color=Rojo;Talla=M</small>
        <input type="text" class="atributos" 
               value="${formatearAtributos(v.atributos_json)}">
      </div>
    </div>
  `).join('');
}

function formatearAtributos(atributos) {
  if (!atributos || typeof atributos !== 'object') return '';
  return Object.entries(atributos)
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
}

// ============================================
// 7. FORMULARIO PARA NUEVA VARIANTE
// ============================================

function renderizarFormularioVariante() {
  return `
    <h4>Crear Nueva Variante</h4>
    
    <div class="form-row">
      <div class="form-group">
        <label>Nombre (ej: Rojo-M)</label>
        <input type="text" class="new-variant-nombre" placeholder="Rojo-M">
      </div>
      
      <div class="form-group">
        <label>Precio Lista</label>
        <input type="number" class="new-variant-precio" placeholder="12.50" step="0.01">
      </div>
    </div>
    
    <div class="form-row">
      <div class="form-group">
        <label>Color</label>
        <input type="text" class="new-variant-color" placeholder="Rojo">
      </div>
      
      <div class="form-group">
        <label>Talla</label>
        <input type="text" class="new-variant-talla" placeholder="M">
      </div>
    </div>
    
    <div class="form-row">
      <div class="form-group">
        <label>Stock Inicial</label>
        <input type="number" class="new-variant-stock" placeholder="10" min="0">
      </div>
      
      <div class="form-group">
        <label>Código de Barras</label>
        <input type="text" class="new-variant-barcode" placeholder="123456789">
      </div>
    </div>
    
    <div class="form-buttons">
      <button type="button" class="btn-secondary" onclick="cancelarVariante()">Cancelar</button>
      <button type="button" class="btn-primary" onclick="crearVarianteNueva()">Crear Variante</button>
    </div>
  `;
}

function agregarFormularioVariante(idProducto) {
  document.getElementById('new-variant-form').style.display = 'block';
}

function cancelarVariante() {
  document.getElementById('new-variant-form').style.display = 'none';
}

async function crearVarianteNueva() {
  const idProducto = document.getElementById('id-producto').value;
  const nombre = document.querySelector('.new-variant-nombre').value.trim();
  const precio = parseFloat(document.querySelector('.new-variant-precio').value) || 0;
  const color = document.querySelector('.new-variant-color').value.trim();
  const talla = document.querySelector('.new-variant-talla').value.trim();
  const stock = parseInt(document.querySelector('.new-variant-stock').value) || 0;
  const barcode = document.querySelector('.new-variant-barcode').value.trim();
  
  if (!nombre || !precio) {
    alert('Nombre y precio son requeridos');
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/inventario/productos/${idProducto}/variantes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${obtenerToken()}`
      },
      body: JSON.stringify({
        nombre_variante: nombre,
        precio_lista: precio,
        codigo_barras: barcode,
        atributos: {
          ...(color && { Color: color }),
          ...(talla && { Talla: talla })
        },
        stock_inicial: stock
      })
    });
    
    if (!response.ok) throw new Error('Error creando variante');
    
    alert('Variante creada! Recarga la tarjeta');
    cancelarVariante();
    
    // Recargar producto
    const sessionData = JSON.parse(localStorage.getItem(STORAGE_KEY));
    cargarProductoEnTarjeta(sessionData.indiceActual);
    
  } catch (error) {
    console.error('Error:', error);
    alert('Error al crear variante');
  }
}

// ============================================
// 8. UPLOAD DE IMÁGENES
// ============================================

function configurarEventosUpload() {
  const uploadArea = document.getElementById('upload-area');
  const imageInput = document.getElementById('image-input');
  
  // Click para seleccionar
  uploadArea.addEventListener('click', () => imageInput.click());
  
  // Drag and drop
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });
  
  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });
  
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    
    const files = Array.from(e.dataTransfer.files);
    imageInput.files = crearFileList(files);
    mostrarPreviewImagenes(files);
  });
  
  // Change en input
  imageInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    mostrarPreviewImagenes(files);
  });
}

function mostrarPreviewImagenes(files) {
  const preview = document.getElementById('image-preview');
  preview.innerHTML = '';
  
  files.forEach((file, idx) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = document.createElement('div');
      img.className = 'preview-item';
      img.innerHTML = `
        <img src="${e.target.result}" alt="Preview">
        <button type="button" class="btn-remove" onclick="removeImage(${idx})">×</button>
      `;
      preview.appendChild(img);
    };
    reader.readAsDataURL(file);
  });
}

// ============================================
// 9. GUARDAR CAMBIOS DEL PRODUCTO
// ============================================

async function guardarProductoActual() {
  const idProducto = document.getElementById('id-producto').value;
  
  // 1. GUARDAR MARCA Y CATEGORÍA
  const idCategoria = document.getElementById('categoria').value;
  const idMarca = document.getElementById('marca').value;
  
  if (!idCategoria || !idMarca) {
    alert('Por favor selecciona categoría y marca');
    return false;
  }
  
  try {
    const responseMarca = await fetch(`${API_BASE}/inventario/productos/${idProducto}/marca`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${obtenerToken()}`
      },
      body: JSON.stringify({
        id_categoria: parseInt(idCategoria),
        id_marca: parseInt(idMarca)
      })
    });
    
    if (!responseMarca.ok) throw new Error('Error guardando marca');
    
    // 2. SUBIR IMÁGENES
    const imageInput = document.getElementById('image-input');
    if (imageInput.files.length > 0) {
      const formData = new FormData();
      Array.from(imageInput.files).forEach(file => {
        formData.append('images', file);
      });
      
      const responseImages = await fetch(`${API_BASE}/productos/images?id_producto=${idProducto}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${obtenerToken()}`
        },
        body: formData
      });
      
      if (!responseImages.ok) console.warn('Advertencia: Algunas imágenes no se cargaron');
    }
    
    return true;
    
  } catch (error) {
    console.error('Error:', error);
    alert('Error guardando cambios');
    return false;
  }
}

// ============================================
// 10. NAVEGACIÓN EN LA COLA
// ============================================

async function siguienteProducto() {
  // Guardar cambios del actual
  const guardado = await guardarProductoActual();
  if (!guardado) return;
  
  const sessionData = JSON.parse(localStorage.getItem(STORAGE_KEY));
  const siguiente = sessionData.indiceActual + 1;
  
  if (siguiente < sessionData.productosIds.length) {
    cargarProductoEnTarjeta(siguiente);
  } else {
    mostrarMensajeFin();
  }
}

async function productoAnterior() {
  const sessionData = JSON.parse(localStorage.getItem(STORAGE_KEY));
  
  if (sessionData.indiceActual > 0) {
    cargarProductoEnTarjeta(sessionData.indiceActual - 1);
  }
}

async function saltarProducto() {
  const sessionData = JSON.parse(localStorage.getItem(STORAGE_KEY));
  const siguiente = sessionData.indiceActual + 1;
  
  if (siguiente < sessionData.productosIds.length) {
    cargarProductoEnTarjeta(siguiente);
  } else {
    mostrarMensajeFin();
  }
}

// ============================================
// 11. FIN DEL PROCESO
// ============================================

function mostrarMensajeFin() {
  document.getElementById('queue-editor').style.display = 'none';
  
  const finDiv = document.getElementById('completion-message');
  finDiv.innerHTML = `
    <div class="completion-card">
      <div class="success-large">✅</div>
      <h2>¡Todos los productos están listos!</h2>
      
      <div class="completion-stats">
        <div class="stat">
          <strong id="stat-count">3</strong>
          <small>Productos completados</small>
        </div>
      </div>
      
      <div class="completion-buttons">
        <button class="btn-primary" onclick="irAlInventario()">Ver en Inventario</button>
        <button class="btn-secondary" onclick="crearOtrosProductos()">Cargar más productos</button>
      </div>
    </div>
  `;
  
  finDiv.style.display = 'block';
  
  // Limpiar localStorage
  localStorage.removeItem(STORAGE_KEY);
}

// ============================================
// 12. UTILIDADES
// ============================================

function obtenerToken() {
  // Obtén el token de donde lo almacenes (localStorage, cookies, etc)
  return localStorage.getItem('authToken') || '';
}

function resetearFormulario() {
  localStorage.removeItem(STORAGE_KEY);
  document.getElementById('quick-load-form').style.display = 'block';
  document.getElementById('load-summary').style.display = 'none';
  document.getElementById('queue-editor').style.display = 'none';
  document.getElementById('completion-message').style.display = 'none';
  
  // Limpiar inputs
  document.querySelectorAll('.producto-row input').forEach(input => input.value = '');
}

function irAlInventario() {
  window.location.href = '/inventario';
}

function crearOtrosProductos() {
  resetearFormulario();
}

function crearFileList(files) {
  const dataTransfer = new DataTransfer();
  files.forEach(file => dataTransfer.items.add(file));
  return dataTransfer.files;
}

function removeImage(index) {
  const imageInput = document.getElementById('image-input');
  const files = Array.from(imageInput.files);
  files.splice(index, 1);
  imageInput.files = crearFileList(files);
  mostrarPreviewImagenes(files);
}

function configurarEventosVariantes() {
  // Aquí puedes agregar eventos para editar variantes existentes si lo necesitas
}

// ============================================
// 13. INICIALIZAR AL CARGAR PÁGINA
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  // Verificar si hay una sesión en curso
  const sessionData = localStorage.getItem(STORAGE_KEY);
  if (sessionData) {
    const data = JSON.parse(sessionData);
    // Preguntar si continuar o iniciar nueva sesión
    if (confirm('¿Tienes una sesión de edición pendiente. ¿Deseas continuarla?')) {
      mostrarResumenCarga(data.productosCargados.length, data.productosCargados);
    } else {
      resetearFormulario();
    }
  }
});

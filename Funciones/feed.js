import pool from '../db.js';


// 1. Obtener productos de la base de datos.
// 2. Enviarlos a Python para ordenarlos.
// 3. Si Python falla, utilizar orden por fecha.
// 4. Devolver los productos completos al frontend.


const pedir_orden_a_python = async (publicaciones) => {
 const urlBase = process.env.PYTHON_URL || 'http://127.0.0.1:5000';
 const url = `${urlBase.replace(/\/+$/, '')}/algoritmo`;


 const post_body = {
   backend_key: process.env.BACKEND_KEY,
   publicaciones
 };


 const respuesta = await fetch(url, {
   method: 'POST',
   headers: {
     'Content-Type': 'application/json'
   },
   body: JSON.stringify(post_body),
   signal: AbortSignal.timeout(3000)
 });


 if (!respuesta.ok) {
   throw new Error(`Python respondió con código ${respuesta.status}`);
 }


 const datos = await respuesta.json();


 let publicaciones_ordenadas;


 if (Array.isArray(datos)) {
   publicaciones_ordenadas = datos;
 } else if (Array.isArray(datos?.resultado)) {
   publicaciones_ordenadas = datos.resultado;
 } else if (Array.isArray(datos?.publicaciones)) {
   publicaciones_ordenadas = datos.publicaciones;
 } else {
   throw new Error('Python no devolvió una lista válida');
 }


 if (publicaciones_ordenadas.length === 0) {
   throw new Error('Python devolvió una lista vacía');
 }


 const ids = publicaciones_ordenadas.map((p) => {
   if (p !== null && typeof p === 'object') {
     return p.id;
   }


   return p;
 });


 return ids;
};


const listar_productos = async (req, res) => {
 try {
   const usuario_id = req.usuario ? req.usuario.id : null;


   // 1. Obtener publicaciones de PostgreSQL.
   const publicaciones_para_py = await pool.query(
     `SELECT
       p.id,
       p.titulo,
       (SELECT nombre_usuario FROM usuario u
         WHERE u.id = p.usuario_publicador_id) AS vendedor,
       p.visualizaciones AS cant_visualizaciones,
       (SELECT COUNT(*)::int FROM comentario c
         WHERE c.publicacion_id = p.id) AS cant_comentarios,
       (SELECT COUNT(*)::int FROM resenas r
         JOIN producto pr ON pr.id = r.producto_id
         WHERE pr.usuario_publicador_id = p.usuario_publicador_id) AS cant_reseñas,
       (SELECT AVG(r.estrellas)::float FROM resenas r
         JOIN producto pr ON pr.id = r.producto_id
         WHERE pr.usuario_publicador_id = p.usuario_publicador_id) AS valor_reseñas,
       (SELECT COUNT(*)::int FROM guardados g
         WHERE g.publicacion_id = p.id) AS cant_guardados,
       EXISTS (
         SELECT 1 FROM ordenes_de_compra o
         WHERE o.vendedor_id = p.usuario_publicador_id
         AND o.comprador_id = $1::int
       ) AS ex_comprador,
       EXISTS (
         SELECT 1 FROM guardados g
         WHERE g.usuario_id = $1::int
         AND g.publicacion_id = p.id
       ) AS guardado,
       EXISTS (
         SELECT 1 FROM direcciones d_vend
         JOIN direcciones d_act
         ON d_act.pais = d_vend.pais
         AND d_act.provincia = d_vend.provincia
         WHERE d_vend.usuario_id = p.usuario_publicador_id
         AND d_act.usuario_id = $1::int
       ) AS misma_provincia,
       EXISTS (
         SELECT 1 FROM direcciones d_vend
         JOIN direcciones d_act
         ON d_act.pais = d_vend.pais
         AND d_act.provincia = d_vend.provincia
         AND d_act.ciudad = d_vend.ciudad
         WHERE d_vend.usuario_id = p.usuario_publicador_id
         AND d_act.usuario_id = $1::int
       ) AS misma_ciudad,
       (SELECT COUNT(*)::int FROM reportes rep
         WHERE rep.usuario_reportado_id = p.usuario_publicador_id
       ) AS cant_reportes_vendedor,
       p.fecha_publicacion AS fecha_publicacion
     FROM producto p
     WHERE p.estado_publicacion = 'disponible'
       AND ($1::int IS NULL OR p.usuario_publicador_id != $1::int)
       AND NOT EXISTS (
         SELECT 1 FROM reportes rep
         WHERE rep.usuario_reportador_id = $1::int
         AND rep.usuario_reportado_id = p.usuario_publicador_id
       )`,
     [usuario_id]
   );


   const publicaciones = publicaciones_para_py.rows;


   if (publicaciones.length === 0) {
     return res.status(200).json([]);
   }


   // Orden de respaldo: publicaciones más recientes primero.
   const orden_por_fecha = [...publicaciones]
     .sort(
       (a, b) =>
         new Date(b.fecha_publicacion).getTime() -
         new Date(a.fecha_publicacion).getTime()
     )
     .map((p) => p.id);


   let orden = orden_por_fecha;


   // 2. Intentar obtener el orden de Python.
   try {
     const orden_python = await pedir_orden_a_python(publicaciones);


     // Aceptar solo IDs que realmente están en la consulta.
     const ids_validos = new Set(
       publicaciones.map((p) => String(p.id))
     );


     const ids_ordenados = [];
     const ids_usados = new Set();


     for (const id of orden_python) {
       const clave = String(id);


       if (
         ids_validos.has(clave) &&
         !ids_usados.has(clave)
       ) {
         ids_ordenados.push(clave);
         ids_usados.add(clave);
       }
     }


     if (ids_ordenados.length === 0) {
       throw new Error('Python no devolvió IDs válidos');
     }


     // Incluir publicaciones que Python haya omitido.
     for (const id of orden_por_fecha) {
       const clave = String(id);


       if (!ids_usados.has(clave)) {
         ids_ordenados.push(clave);
         ids_usados.add(clave);
       }
     }


     orden = ids_ordenados;


   } catch (error) {
     console.error(
       'Error al ordenar con Python:',
       error.message
     );


     console.log(
       'Usando orden de respaldo por fecha.'
     );


     orden = orden_por_fecha;
   }


   // 3. Obtener los productos completos.
   const productos_ordenados = [];


   for (const id of orden) {
     const resultado = await pool.query(
       `SELECT
         p.id,
         p.titulo,
         p.descripcion,
         p.precio::float AS precio,
         p.talle,
         p.color,
         p.marca,
         p.tipo_prenda,
         p.subtipo_prenda,
         p.genero,
         p.stock,
         p.estado_condicion,
         p.foto,
         p.visualizaciones,
         p.cantidad_guardados,
         p.fecha_publicacion,
         p.usuario_publicador_id,
         u.nombre_usuario AS vendedor_nombre_usuario,
         u.verificado AS vendedor_verificado
       FROM producto p
       JOIN usuario u ON u.id = p.usuario_publicador_id
       WHERE p.id = $1`,
       [id]
     );


     if (resultado.rows.length > 0) {
       productos_ordenados.push(resultado.rows[0]);
     }
   }


   // 4. Devolver las prendas al frontend.
   return res.status(200).json(productos_ordenados);


 } catch (error) {
   console.error(
     'Error al obtener los productos:',
     error
   );


   return res.status(500).json({
     error: 'Error al obtener los productos'
   });
 }
};


export { listar_productos };

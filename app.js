/* ============================================================
   Augurio 2.0 — lógica del front-end
   El backend de n8n (+ Supabase) ya está en producción: CONFIG.webhooks
   apunta a los tres endpoints reales. Si en algún momento hay que
   volver al modo demo (por ejemplo para iterar diseño sin depender
   del backend), basta con vaciar CONFIG.webhooks.chat y
   CONFIG.webhooks.fichas: todo el sitio vuelve a operar con datos
   simulados. El modo demo no es un andamio temporal, es un camino de
   ejecución de primera clase que se conserva a propósito.
   ============================================================ */

/* ---------- Configuración: único lugar para todo lo ajustable ---------- */

const CONFIG = {
  // Identifica el proyecto en n8n/Supabase. Viaja en el chat y al
  // arrancar las fichas (el backend usa 'augurio-demo' si no llega).
  proyecto: 'augurio-demo',
  // 'completo': se esperan y muestran las 5 fichas (comportamiento de
  // siempre). 'recoleccion': modo del taller — el backend solo genera
  // las fichas de CONFIG.fichasEnVivo; las demás se pintan como
  // "en elaboración" en el front, sin esperarlas del backend.
  modo: 'recoleccion', // 'completo' | 'recoleccion'
  fichasEnVivo: ['ficha1', 'ficha2'], // ids que SÍ llegan en modo 'recoleccion'; se ignora en 'completo'
  webhooks: {
    chat: 'https://fabianh.app.n8n.cloud/webhook/augurio/chat',
    fichas: 'https://fabianh.app.n8n.cloud/webhook/augurio/fichas',
    estadoFichas: 'https://fabianh.app.n8n.cloud/webhook/augurio/estado-fichas',
    modoFichas: 'asincrono', // el backend siempre responde 202 + job_id, nunca fichas directas
  },
  sesion: {
    expiraEnMinutos: null, // null = la sesión no expira nunca por inactividad
  },
  timeouts: {
    fichasMs: 90000,      // presupuesto total de cliente para obtener las fichas (AbortController)
    pollingMs: 2000,       // intervalo entre sondeos en modo 'asincrono'
  },
  demo: {
    latenciaFichasMs: 3000, // latencia simulada cuando CONFIG.webhooks.fichas está vacío
  },
};

// Los cinco ids de ficha, en el orden fijo del layout. Se usan para
// validar, para pintar cada estado y para restaurar el placeholder.
const ID_FICHAS = ['ficha1', 'ficha2', 'ficha3', 'ficha4', 'ficha5'];

// Los tipos de contenido que el backend documenta para el campo "tipo"
// de cada ficha. Es metadata (no gobierna el render), pero validarFichas
// la verifica para detectar un typo o un cambio de contrato del backend.
const TIPOS_FICHA = ['texto', 'tabla', 'grafo', 'mapa_calor', 'gantt'];

/* ============================================================
   Identidad de sesión
   No hay autenticación: la conversación solo se puede reconstruir
   por un id que nace en el cliente y viaja en cada payload saliente.
   ============================================================ */

function lsGet(clave) {
  try { return localStorage.getItem(clave); } catch { return null; }
}
function lsSet(clave, valor) {
  try { localStorage.setItem(clave, valor); } catch { /* almacenamiento no disponible */ }
}
function lsRemove(clave) {
  try { localStorage.removeItem(clave); } catch { /* almacenamiento no disponible */ }
}

function generarIdSesion() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback para contextos no seguros (crypto.randomUUID exige HTTPS o localhost).
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function sesionExpirada() {
  const minutos = CONFIG.sesion.expiraEnMinutos;
  if (!minutos) return false;
  const referencia = lsGet('augurio_session_last_activity') || lsGet('augurio_session_started_at');
  if (!referencia) return false;
  const minutosTranscurridos = (Date.now() - new Date(referencia).getTime()) / 60000;
  return minutosTranscurridos > minutos;
}

function crearSesion() {
  const id = generarIdSesion();
  const ahora = new Date().toISOString();
  lsSet('augurio_session_id', id);
  lsSet('augurio_session_started_at', ahora);
  lsSet('augurio_session_last_activity', ahora);
  return id;
}

function inicializarSesion() {
  const existente = lsGet('augurio_session_id');
  if (!existente || sesionExpirada()) {
    return crearSesion();
  }
  return existente;
}

let sessionId = inicializarSesion();

// Sin efectos colaterales más allá de la escritura inicial de arriba:
// llamarla repetidamente solo devuelve el id ya resuelto.
function getSessionId() {
  return sessionId;
}

// Actualiza la marca de actividad (para el cálculo de expiración por
// inactividad). Se llama en cada interacción real: enviar un mensaje
// o pedir las fichas.
function marcarActividadSesion() {
  lsSet('augurio_session_last_activity', new Date().toISOString());
}

function reiniciarSesion() {
  lsRemove('augurio_session_id');
  lsRemove('augurio_session_started_at');
  lsRemove('augurio_session_last_activity');
  sessionId = crearSesion();
  return sessionId;
}

// Accesible desde la consola del navegador para probar sin borrar
// localStorage a mano: window.augurio.reiniciarSesion()
window.augurio = { reiniciarSesion };

/* ============================================================
   Red: un solo helper para todos los fetch
   ============================================================ */

function nuevoAbortError() {
  return typeof DOMException === 'function'
    ? new DOMException('Abortado', 'AbortError')
    : Object.assign(new Error('Abortado'), { name: 'AbortError' });
}

// Espera ms milisegundos; si signal se aborta antes, rechaza con
// AbortError en vez de esperar hasta el final.
function esperar(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(nuevoAbortError());
      return;
    }
    const temporizador = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(temporizador);
        reject(nuevoAbortError());
      }, { once: true });
    }
  });
}

/**
 * llamarWebhook(url, payload, { signal })
 * ----------------------------------------
 * Único punto de salida hacia n8n. Siempre POST con JSON. Devuelve
 * siempre la misma forma de resultado, nunca lanza:
 *   { ok: true,  data, status }
 *   { ok: false, error, status?, abortado? }
 *
 * Reintenta con backoff exponencial (2 intentos extra: 1s y 4s) solo
 * cuando el fallo es de red o el status es 429 o 5xx. Un 4xx que no
 * sea 429 se devuelve de inmediato, sin reintentar.
 */
async function llamarWebhook(url, payload, { signal } = {}) {
  const esperas = [0, 1000, 4000]; // intento inicial + 2 reintentos
  let ultimoError = 'Error desconocido.';
  let ultimoStatus;

  for (let intento = 0; intento < esperas.length; intento++) {
    if (esperas[intento] > 0) {
      try {
        await esperar(esperas[intento], signal);
      } catch (err) {
        return { ok: false, error: 'Solicitud cancelada.', abortado: true };
      }
    }

    try {
      const respuesta = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });

      if (respuesta.ok) {
        const texto = await respuesta.text();
        let datos = null;
        if (texto) {
          try {
            datos = JSON.parse(texto);
          } catch {
            return { ok: false, error: 'La respuesta no es JSON válido.', status: respuesta.status };
          }
        }
        return { ok: true, data: datos, status: respuesta.status };
      }

      ultimoStatus = respuesta.status;
      ultimoError = `Error HTTP ${respuesta.status}`;
      const reintentable = respuesta.status === 429 || respuesta.status >= 500;
      if (!reintentable || intento === esperas.length - 1) {
        return { ok: false, error: ultimoError, status: respuesta.status };
      }
      // status reintentable: el for continúa al siguiente intento
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { ok: false, error: 'Solicitud cancelada.', abortado: true };
      }
      ultimoError = (err && err.message) || 'Error de red.';
      if (intento === esperas.length - 1) {
        return { ok: false, error: ultimoError };
      }
      // fallo de red: el for continúa al siguiente intento
    }
  }

  return { ok: false, error: ultimoError, status: ultimoStatus };
}

/* ---------- Chat ---------- */

const chatVentana = document.getElementById('chatVentana');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

function agregarMensaje(texto, quien) {
  const div = document.createElement('div');
  div.className = `msg msg-${quien}`;
  div.textContent = texto;
  chatVentana.appendChild(div);
  chatVentana.scrollTop = chatVentana.scrollHeight;
  return div;
}

// En modo 'recoleccion' el primer turno del usuario se guarda como
// alias y viaja en los payloads del chat desde ese momento. Se
// persiste para sobrevivir a una recarga a mitad de conversación.
let alias = CONFIG.modo === 'recoleccion' ? (lsGet('augurio_alias') || '') : '';

function capturarAliasSiHaceFalta(texto) {
  if (CONFIG.modo !== 'recoleccion' || alias) return;
  alias = texto.trim();
  lsSet('augurio_alias', alias);
}

// Mensaje sobrio para cuando el helper de red agotó sus reintentos:
// el mensaje del usuario no se pierde, queda visible con un botón
// para reenviarlo (el texto original vive en el closure de quien
// llama, no en este HTML).
function plantillaErrorMensaje() {
  return `No pude enviar tu mensaje. <button type="button" class="js-reintentar-mensaje" style="
    margin-left: 6px;
    padding: 4px 14px;
    border-radius: 999px;
    border: 1px solid currentColor;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
  ">Reintentar</button>`;
}

async function responderBot(textoUsuario) {
  const escribiendo = agregarMensaje('...', 'bot');
  escribiendo.classList.add('msg-escribiendo');

  marcarActividadSesion();

  if (CONFIG.webhooks.chat) {
    // Camino real: POST al webhook de n8n, vía el helper centralizado
    const payload = { mensaje: textoUsuario, session_id: getSessionId(), proyecto: CONFIG.proyecto };
    if (CONFIG.modo === 'recoleccion') payload.alias = alias;
    const resultado = await llamarWebhook(CONFIG.webhooks.chat, payload);
    escribiendo.classList.remove('msg-escribiendo');
    if (resultado.ok) {
      const data = resultado.data || {};
      escribiendo.textContent = data.respuesta ?? JSON.stringify(data);
    } else {
      // Reintentos del helper agotados: no se pierde en silencio, se
      // ofrece reenviar el mismo texto con un clic.
      escribiendo.innerHTML = plantillaErrorMensaje();
      escribiendo.querySelector('.js-reintentar-mensaje').addEventListener('click', () => {
        escribiendo.remove();
        responderBot(textoUsuario);
      }, { once: true });
    }
    chatVentana.scrollTop = chatVentana.scrollHeight;
    return;
  }

  // Camino local: respuesta simulada mientras n8n no existe
  await new Promise(r => setTimeout(r, 700));
  escribiendo.textContent = `[simulado] Recibí tu mensaje: "${textoUsuario}". Cuando n8n esté listo, aquí llegará la respuesta real del sistema.`;
  escribiendo.classList.remove('msg-escribiendo');
  chatVentana.scrollTop = chatVentana.scrollHeight;
}

function enviarMensaje() {
  const texto = chatInput.value.trim();
  if (!texto) return;
  capturarAliasSiHaceFalta(texto);
  agregarMensaje(texto, 'usuario');
  chatInput.value = '';
  responderBot(texto);
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  enviarMensaje();
});

// Enter envía, Shift+Enter hace salto de línea
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    enviarMensaje();
  }
});

/* ============================================================
   Contrato de datos — respuesta del endpoint de fichas
   ============================================================
   La respuesta (síncrona, o el campo "fichas" de un sondeo asíncrono
   con estado "listo") debe ser un ARRAY de exactamente 5 objetos, uno
   por cada Objeto Consultivo, con esta forma exacta:

     {
       id:   string,  // uno de 'ficha1' | 'ficha2' | 'ficha3' | 'ficha4' | 'ficha5'.
                        // Los 5 ids deben estar presentes una sola vez cada uno.
       tipo: string,   // uno de: 'texto' | 'tabla' | 'grafo' | 'mapa_calor' | 'gantt'
                        // (ver TIPOS_FICHA). Es metadata informativa para
                        // quien lea el dato: no gobierna el render, pero
                        // validarFichas la exige para detectar un typo o
                        // un cambio de contrato del lado del backend.
       html: string,   // fragmento HTML ya armado, listo para insertarse con
                        // innerHTML dentro de .ficha-cuerpo. Debe envolver su
                        // contenido en <div class="ficha-contenido"> para
                        // heredar los estilos ya definidos en styles.css
                        // (párrafos, .ficha-tabla, .ficha-grafo/.ficha-calor/.ficha-gantt).
     }

   validarFichas(data) verifica esta forma antes de renderizar cualquier
   cosa. Tanto el modo demo (DUMMY_FICHAS) como las respuestas reales de
   n8n pasan por el mismo validador: si el dummy no valida contra su
   propio contrato, es un bug que debe verse, no esconderse.

   Excepción — CONFIG.modo === 'recoleccion': el backend solo genera
   las fichas de CONFIG.fichasEnVivo (hoy ficha1 y ficha2). El array
   debe traer EXACTAMENTE esas, ni más ni menos; el resto de las
   tarjetas (ficha3..5) se pintan con FICHA_EN_ELABORACION, un
   placeholder fijo del front que nunca se espera del backend.
   ============================================================ */

const DUMMY_FICHAS = [
  {
    id: 'ficha1',
    tipo: 'texto',
    html: `
    <div class="ficha-contenido">
      <p>Al leer las voces del grupo juntas emerge un patrón que nadie escribió por separado:
      la convicción de que la singularidad de la institución no está en sus programas sino en
      su manera de conversar. Las respuestas convergen en una tensión entre el orgullo por lo
      construido y la urgencia de decidir qué se suelta para poder avanzar. Este párrafo es
      contenido simulado; cuando n8n esté conectado, aquí llegará la conclusión colectiva real.</p>
    </div>`,
  },
  {
    id: 'ficha2',
    tipo: 'tabla',
    html: `
    <div class="ficha-contenido">
      <table class="ficha-tabla">
        <thead>
          <tr><th>Voz</th><th>Idea central</th><th>Convergencia</th><th>Presupuesto</th></tr>
        </thead>
        <tbody>
          <tr><td>Usuario 1</td><td>Identidad biopsicosocial</td><td>Alta</td><td>$620M COP</td></tr>
          <tr><td>Usuario 2</td><td>Gobernanza de datos</td><td>Media</td><td>$380M COP</td></tr>
          <tr><td>Usuario 3</td><td>Formación docente en IA</td><td>Alta</td><td>$540M COP</td></tr>
          <tr><td>Usuario 4</td><td>Sostenibilidad financiera</td><td>Baja</td><td>$210M COP</td></tr>
          <tr><td>Usuario 5</td><td>Identidad biopsicosocial</td><td>Alta</td><td>$650M COP</td></tr>
        </tbody>
      </table>
    </div>`,
  },
  {
    id: 'ficha3',
    tipo: 'grafo',
    html: `
    <div class="ficha-contenido">
      <svg class="ficha-grafo" viewBox="0 0 520 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Grafo de agrupamiento simulado">
        <line x1="120" y1="80"  x2="250" y2="130" stroke="rgba(20,20,15,.28)" stroke-width="2"/>
        <line x1="120" y1="200" x2="250" y2="130" stroke="rgba(20,20,15,.28)" stroke-width="2"/>
        <line x1="250" y1="130" x2="390" y2="70"  stroke="rgba(20,20,15,.28)" stroke-width="2"/>
        <line x1="250" y1="130" x2="400" y2="190" stroke="rgba(20,20,15,.28)" stroke-width="2"/>
        <line x1="390" y1="70"  x2="400" y2="190" stroke="rgba(20,20,15,.28)" stroke-width="2"/>
        <circle cx="120" cy="80"  r="10" fill="#14140F"/>
        <circle cx="120" cy="200" r="10" fill="#14140F"/>
        <circle cx="390" cy="70"  r="10" fill="#14140F"/>
        <circle cx="250" cy="130" r="16" fill="#1F8EFF"/>
        <circle cx="400" cy="190" r="14" fill="none" stroke="#1F8EFF" stroke-width="2" stroke-dasharray="4 4"/>
        <text x="120" y="60"  text-anchor="middle" font-size="11" fill="#14140F">Usuario 1</text>
        <text x="120" y="224" text-anchor="middle" font-size="11" fill="#14140F">Usuario 2</text>
        <text x="390" y="50"  text-anchor="middle" font-size="11" fill="#14140F">Usuario 3</text>
        <text x="250" y="162" text-anchor="middle" font-size="11" font-weight="700" fill="#14140F">Idea central</text>
        <text x="400" y="222" text-anchor="middle" font-size="11" fill="#14140F">Idea ausente</text>
      </svg>
    </div>`,
  },
  {
    id: 'ficha4',
    tipo: 'mapa_calor',
    html: `
    <div class="ficha-contenido">
      <svg class="ficha-calor" viewBox="0 0 560 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mapa de calor simulado de las palabras del grupo">
        <defs>
          <radialGradient id="calor-azul" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#1F8EFF" stop-opacity=".7"/>
            <stop offset="55%" stop-color="#1F8EFF" stop-opacity=".28"/>
            <stop offset="100%" stop-color="#1F8EFF" stop-opacity="0"/>
          </radialGradient>
        </defs>

        <!-- Grid sutil de cuadrantes, como mapa de navegación -->
        <g stroke="#14140F" stroke-width="1" opacity=".14">
          <line x1="70"  y1="0" x2="70"  y2="300"/>
          <line x1="140" y1="0" x2="140" y2="300"/>
          <line x1="210" y1="0" x2="210" y2="300"/>
          <line x1="350" y1="0" x2="350" y2="300"/>
          <line x1="420" y1="0" x2="420" y2="300"/>
          <line x1="490" y1="0" x2="490" y2="300"/>
          <line x1="0" y1="75"  x2="560" y2="75"/>
          <line x1="0" y1="225" x2="560" y2="225"/>
        </g>
        <!-- Ejes centrales de los cuadrantes, apenas más presentes -->
        <g stroke="#14140F" stroke-width="1" opacity=".28">
          <line x1="280" y1="0" x2="280" y2="300"/>
          <line x1="0" y1="150" x2="560" y2="150"/>
        </g>

        <!-- Zonas de calor -->
        <ellipse cx="170" cy="120" rx="150" ry="105" fill="url(#calor-azul)"/>
        <ellipse cx="400" cy="90"  rx="130" ry="85"  fill="url(#calor-azul)" opacity=".8"/>
        <ellipse cx="330" cy="220" rx="160" ry="80"  fill="url(#calor-azul)" opacity=".65"/>
        <ellipse cx="80"  cy="250" rx="90"  ry="55"  fill="url(#calor-azul)" opacity=".5"/>

        <!-- Curvas de nivel, como mapa de relieve -->
        <ellipse cx="170" cy="120" rx="55"  ry="38"  fill="none" stroke="#1F8EFF" stroke-width="1" opacity=".5"/>
        <ellipse cx="170" cy="120" rx="95"  ry="66"  fill="none" stroke="#1F8EFF" stroke-width="1" opacity=".32"/>
        <ellipse cx="170" cy="120" rx="135" ry="94"  fill="none" stroke="#1F8EFF" stroke-width="1" opacity=".2"/>
        <ellipse cx="400" cy="90"  rx="50"  ry="33"  fill="none" stroke="#1F8EFF" stroke-width="1" opacity=".45"/>
        <ellipse cx="400" cy="90"  rx="90"  ry="59"  fill="none" stroke="#1F8EFF" stroke-width="1" opacity=".28"/>
        <ellipse cx="330" cy="220" rx="70"  ry="35"  fill="none" stroke="#1F8EFF" stroke-width="1" opacity=".38"/>
        <ellipse cx="330" cy="220" rx="120" ry="60"  fill="none" stroke="#1F8EFF" stroke-width="1" opacity=".22"/>

        <!-- Palabras -->
        <text x="170" y="126" text-anchor="middle" font-size="26" font-weight="800" fill="#14140F">identidad</text>
        <text x="150" y="90"  text-anchor="middle" font-size="13" fill="#14140F" opacity=".8">bienestar</text>
        <text x="235" y="160" text-anchor="middle" font-size="15" fill="#14140F" opacity=".9">comunidad</text>
        <text x="95"  y="160" text-anchor="middle" font-size="12" fill="#14140F" opacity=".6">salud mental</text>
        <text x="90"  y="60"  text-anchor="middle" font-size="11" fill="#14140F" opacity=".5">confianza</text>

        <text x="400" y="95"  text-anchor="middle" font-size="24" font-weight="800" fill="#14140F">IA</text>
        <text x="455" y="65"  text-anchor="middle" font-size="14" fill="#14140F" opacity=".8">docencia</text>
        <text x="350" y="55"  text-anchor="middle" font-size="12" fill="#14140F" opacity=".6">currículo</text>
        <text x="470" y="130" text-anchor="middle" font-size="13" fill="#14140F" opacity=".75">innovación</text>
        <text x="330" y="120" text-anchor="middle" font-size="11" fill="#14140F" opacity=".5">pedagogía</text>

        <text x="330" y="226" text-anchor="middle" font-size="20" font-weight="800" fill="#14140F">gobernanza</text>
        <text x="430" y="200" text-anchor="middle" font-size="13" fill="#14140F" opacity=".75">datos</text>
        <text x="250" y="255" text-anchor="middle" font-size="12" fill="#14140F" opacity=".6">ética</text>
        <text x="420" y="255" text-anchor="middle" font-size="11" fill="#14140F" opacity=".5">acreditación</text>
        <text x="500" y="230" text-anchor="middle" font-size="10" fill="#14140F" opacity=".45">presupuesto</text>

        <text x="80"  y="255" text-anchor="middle" font-size="15" font-weight="700" fill="#14140F" opacity=".85">estudiantes</text>
        <text x="130" y="285" text-anchor="middle" font-size="11" fill="#14140F" opacity=".5">egresados</text>
        <text x="40"  y="220" text-anchor="middle" font-size="10" fill="#14140F" opacity=".45">territorio</text>

        <text x="530" y="30" text-anchor="end" font-size="10" fill="#14140F" opacity=".6">densidad de palabras del grupo</text>
      </svg>
    </div>`,
  },
  {
    id: 'ficha5',
    tipo: 'gantt',
    html: `
    <div class="ficha-contenido">
      <svg class="ficha-gantt" viewBox="0 0 560 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Cronograma simulado del proyecto 2026">
        <!-- Rejilla de trimestres -->
        <line x1="120" y1="30" x2="120" y2="215" stroke="rgba(20,20,15,.2)" stroke-width="1"/>
        <line x1="227.5" y1="30" x2="227.5" y2="215" stroke="rgba(20,20,15,.2)" stroke-width="1"/>
        <line x1="335" y1="30" x2="335" y2="215" stroke="rgba(20,20,15,.2)" stroke-width="1"/>
        <line x1="442.5" y1="30" x2="442.5" y2="215" stroke="rgba(20,20,15,.2)" stroke-width="1"/>
        <line x1="550" y1="30" x2="550" y2="215" stroke="rgba(20,20,15,.2)" stroke-width="1"/>
        <text x="173" y="22" text-anchor="middle" font-size="11" fill="#14140F">T1</text>
        <text x="281" y="22" text-anchor="middle" font-size="11" fill="#14140F">T2</text>
        <text x="388" y="22" text-anchor="middle" font-size="11" fill="#14140F">T3</text>
        <text x="496" y="22" text-anchor="middle" font-size="11" fill="#14140F">T4</text>

        <!-- Tareas -->
        <text x="110" y="55" text-anchor="end" font-size="11" fill="#14140F">Diagnóstico</text>
        <rect x="120" y="45" width="72" height="14" rx="7" fill="#14140F"/>

        <text x="110" y="91" text-anchor="end" font-size="11" fill="#14140F">Diseño del piloto</text>
        <rect x="174" y="81" width="90" height="14" rx="7" fill="#14140F"/>

        <text x="110" y="127" text-anchor="end" font-size="11" fill="#14140F">Formación docente</text>
        <rect x="228" y="117" width="143" height="14" rx="7" fill="#14140F"/>

        <text x="110" y="163" text-anchor="end" font-size="11" fill="#14140F">Implementación</text>
        <rect x="335" y="153" width="143" height="14" rx="7" fill="#1F8EFF"/>

        <text x="110" y="199" text-anchor="end" font-size="11" fill="#14140F">Evaluación</text>
        <rect x="460" y="189" width="90" height="14" rx="7" fill="#14140F"/>

        <!-- Hito de cierre -->
        <path d="M550 196 l7 -7 l7 7 l-7 7 Z" transform="translate(-11,0)" fill="#1F8EFF" stroke="#14140F" stroke-width="1"/>
        <text x="120" y="240" font-size="10" fill="#14140F">Proyecto IA 2026 · el rombo marca la entrega final</text>
      </svg>
    </div>`,
  },
];

// Verifica la forma del contrato de arriba. No renderiza nada: solo
// dice si data es seguro de pintar y por qué no, si no lo es.
function validarFichas(data) {
  const errores = [];

  if (!Array.isArray(data)) {
    return { ok: false, errores: ['La respuesta debe ser un array.'] };
  }

  // En modo 'completo' se exigen las 5 fichas de siempre. En modo
  // 'recoleccion' solo se esperan las de CONFIG.fichasEnVivo: el resto
  // no lo manda el backend a propósito y no debe reclamarse aquí.
  const idsEsperados = CONFIG.modo === 'recoleccion' ? CONFIG.fichasEnVivo : ID_FICHAS;

  if (data.length !== idsEsperados.length) {
    errores.push(`Se esperaban ${idsEsperados.length} fichas y llegaron ${data.length}.`);
  }

  const idsVistos = new Set();
  data.forEach((ficha, indice) => {
    if (typeof ficha !== 'object' || ficha === null) {
      errores.push(`La ficha en la posición ${indice} no es un objeto.`);
      return;
    }
    if (typeof ficha.id !== 'string' || !ID_FICHAS.includes(ficha.id)) {
      errores.push(`La ficha en la posición ${indice} tiene un "id" inválido: ${JSON.stringify(ficha.id)}.`);
    } else if (!idsEsperados.includes(ficha.id)) {
      errores.push(`La ficha "${ficha.id}" no se esperaba en modo "${CONFIG.modo}".`);
    } else if (idsVistos.has(ficha.id)) {
      errores.push(`El id "${ficha.id}" está repetido.`);
    } else {
      idsVistos.add(ficha.id);
    }
    if (typeof ficha.tipo !== 'string' || !TIPOS_FICHA.includes(ficha.tipo)) {
      errores.push(`La ficha "${ficha.id ?? indice}" tiene un "tipo" inválido: ${JSON.stringify(ficha.tipo)}.`);
    }
    if (typeof ficha.html !== 'string' || ficha.html.trim() === '') {
      errores.push(`La ficha "${ficha.id ?? indice}" no tiene "html" válido.`);
    }
  });

  for (const id of idsEsperados) {
    if (!idsVistos.has(id)) {
      errores.push(`Falta la ficha con id "${id}".`);
    }
  }

  return { ok: errores.length === 0, errores };
}

// Placeholder fijo para las fichas que en modo 'recoleccion' no llegan
// del backend (se generan después, por fuera, sobre las conversaciones
// guardadas). Vive en el front: nunca se espera del backend.
const FICHA_EN_ELABORACION = `
    <div class="ficha-contenido">
      <p>Este análisis llegará en el informe.</p>
    </div>`;

// Estado vacío original de cada ficha (el placeholder que ya trae el
// HTML), para poder volver a él sin duplicar ese texto en el JS.
const PLACEHOLDERS_FICHAS = {};
for (const id of ID_FICHAS) {
  PLACEHOLDERS_FICHAS[id] = document.getElementById(id).innerHTML;
}

/* ============================================================
   Máquina de estados de las fichas
   'dormidas' | 'procesando' | 'llenas' | 'error'
   setEstadoFichas() es el único punto que cambia estadoFichas y
   repinta el DOM; ninguna otra parte del código toca el estado
   directamente.
   ============================================================ */

let estadoFichas = 'dormidas';
let ultimasFichas = null;      // último array válido, para pintar 'llenas'
let ultimoErrorFichas = '';    // último mensaje, para pintar 'error'

function escapeHtml(texto) {
  return String(texto)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function plantillaError(mensaje) {
  return `
    <div class="ficha-contenido">
      <p>${escapeHtml(mensaje)}</p>
      <button type="button" class="js-reintentar-fichas" style="
        margin-top: 16px;
        padding: 10px 20px;
        border-radius: 999px;
        border: 1px solid currentColor;
        background: transparent;
        color: inherit;
        font-family: inherit;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
      ">Reintentar</button>
    </div>`;
}

function setEstadoFichas(nuevo) {
  estadoFichas = nuevo;

  if (nuevo === 'dormidas') {
    for (const id of ID_FICHAS) {
      const cuerpo = document.getElementById(id);
      cuerpo.innerHTML = PLACEHOLDERS_FICHAS[id];
      cuerpo.closest('.tarjeta-ficha').classList.add('tarjeta-ficha--vacia');
    }
    return;
  }

  if (nuevo === 'procesando') {
    // La animación vive mientras dure este estado, sin atarse a ningún
    // temporizador: quien la retira es la próxima llamada a setEstadoFichas.
    for (const id of ID_FICHAS) {
      const cuerpo = document.getElementById(id);
      cuerpo.closest('.tarjeta-ficha').classList.remove('tarjeta-ficha--vacia');
      cuerpo.innerHTML =
        '<div class="ficha-procesando" aria-label="Procesando">' +
        '<span></span><span></span><span></span>' +
        '</div>';
    }
    return;
  }

  if (nuevo === 'llenas') {
    for (const ficha of ultimasFichas || []) {
      const cuerpo = document.getElementById(ficha.id);
      if (cuerpo) cuerpo.innerHTML = ficha.html;
    }
    // En modo 'recoleccion' las tarjetas que no vinieron en la
    // respuesta (ficha3..5, por defecto) se encienden igual que las
    // demás pero con el placeholder fijo, no con nada del backend.
    if (CONFIG.modo === 'recoleccion') {
      for (const id of ID_FICHAS) {
        if (!CONFIG.fichasEnVivo.includes(id)) {
          const cuerpo = document.getElementById(id);
          if (cuerpo) cuerpo.innerHTML = FICHA_EN_ELABORACION;
        }
      }
    }
    return;
  }

  if (nuevo === 'error') {
    const mensaje = ultimoErrorFichas || 'No pudimos generar el material. Intenta de nuevo.';
    for (const id of ID_FICHAS) {
      const cuerpo = document.getElementById(id);
      cuerpo.closest('.tarjeta-ficha').classList.remove('tarjeta-ficha--vacia');
      cuerpo.innerHTML = plantillaError(mensaje);
    }
    for (const boton of document.querySelectorAll('.js-reintentar-fichas')) {
      boton.addEventListener('click', iniciarObtencionFichas);
    }
    return;
  }
}

/* ---------- Obtención de las fichas: una sola llamada, no cinco ---------- */

// Distingue el mensaje que el backend arma a propósito para mostrarse
// (estado:'error' + mensaje, en el sondeo) de una falla técnica
// cualquiera (HTTP, red, forma inválida), que sigue mostrando el
// mensaje sobrio genérico de siempre.
class ErrorDeBackend extends Error {}

// Modo 'asincrono': un POST de arranque que devuelve 202 + job_id, y
// sondeo periódico a CONFIG.webhooks.estadoFichas hasta 'listo' o 'error'.
async function obtenerFichasAsincrono(payload, signal) {
  const inicio = await llamarWebhook(CONFIG.webhooks.fichas, payload, { signal });
  if (!inicio.ok) {
    throw new Error(inicio.error || 'No se pudo iniciar el análisis.');
  }

  const jobId = inicio.data && inicio.data.job_id;
  if (!jobId) {
    throw new Error('La respuesta no incluyó un job_id.');
  }

  for (;;) {
    await esperar(CONFIG.timeouts.pollingMs, signal);

    const estado = await llamarWebhook(
      CONFIG.webhooks.estadoFichas,
      { session_id: payload.session_id, job_id: jobId },
      { signal }
    );
    if (!estado.ok) {
      throw new Error(estado.error || 'No se pudo consultar el estado del análisis.');
    }

    const cuerpo = estado.data || {};
    if (cuerpo.estado === 'listo') {
      return cuerpo.fichas;
    }
    if (cuerpo.estado === 'error') {
      throw new ErrorDeBackend(cuerpo.mensaje || 'El análisis terminó con error.');
    }
    // cualquier otro valor (procesando, pendiente, ausente...) → seguir sondeando
  }
}

async function iniciarObtencionFichas() {
  setEstadoFichas('procesando');
  marcarActividadSesion();

  const controlador = new AbortController();
  const idTimeout = setTimeout(() => controlador.abort(), CONFIG.timeouts.fichasMs);

  try {
    const payload = { session_id: getSessionId(), proyecto: CONFIG.proyecto };
    let fichas;

    if (!CONFIG.webhooks.fichas) {
      // Modo demo: sin webhook configurado, simula la latencia real
      // y usa el mismo contenido de siempre. En 'recoleccion' se recorta
      // a las fichas en vivo, para poder probar el modo taller offline.
      await esperar(CONFIG.demo.latenciaFichasMs, controlador.signal);
      fichas = CONFIG.modo === 'recoleccion'
        ? DUMMY_FICHAS.filter(f => CONFIG.fichasEnVivo.includes(f.id))
        : DUMMY_FICHAS;
    } else if (CONFIG.webhooks.modoFichas === 'asincrono') {
      fichas = await obtenerFichasAsincrono(payload, controlador.signal);
    } else {
      const resultado = await llamarWebhook(CONFIG.webhooks.fichas, payload, { signal: controlador.signal });
      if (!resultado.ok) throw new Error(resultado.error || 'Error al generar el material.');
      fichas = resultado.data;
    }

    const validacion = validarFichas(fichas);
    if (!validacion.ok) {
      console.error('Fichas inválidas:', validacion.errores);
      ultimoErrorFichas = 'El material recibido no tiene el formato esperado.';
      setEstadoFichas('error');
      return;
    }

    ultimasFichas = fichas;
    setEstadoFichas('llenas');
  } catch (err) {
    if (err && err.name === 'AbortError') {
      ultimoErrorFichas = 'La generación está tardando más de lo esperado. Intenta de nuevo.';
    } else if (err instanceof ErrorDeBackend) {
      // Mensaje que el propio backend armó para mostrarse (estado:'error').
      ultimoErrorFichas = err.message;
    } else {
      // Falla técnica (HTTP, red, forma inválida, job_id ausente...):
      // mensaje sobrio genérico, nunca el detalle crudo.
      ultimoErrorFichas = 'No pudimos generar el material. Intenta de nuevo.';
    }
    setEstadoFichas('error');
  } finally {
    clearTimeout(idTimeout);
  }
}

// Handler de la pill "Terminar la conversacion". El estado, no una
// bandera aparte, decide si el clic hace algo: solo 'dormidas' arranca
// el proceso y solo 'llenas' permite volver a dormir las fichas.
// Desde 'procesando' o 'error' el clic en la pill no hace nada (en
// 'error' el reintento vive en el botón dentro de cada ficha).
function mostrarCognicionAumentada() {
  if (estadoFichas === 'dormidas') {
    iniciarObtencionFichas();
  } else if (estadoFichas === 'llenas') {
    setEstadoFichas('dormidas');
  }
}

document.getElementById('btnCognicion').addEventListener('click', mostrarCognicionAumentada);

/* ---------- Acerca del chat: flip horizontal de la tarjeta ---------- */

document.getElementById('btnAcercaChat').addEventListener('click', () => {
  document.getElementById('flipChat').classList.toggle('volteado');
});

/* ---------- Acerca de cada ficha: flip vertical de su tarjeta ---------- */

for (const btn of document.querySelectorAll('.btn-flip-ficha')) {
  btn.addEventListener('click', () => {
    btn.closest('.bloque-ficha').querySelector('.flip-ficha').classList.toggle('volteado');
  });
}

/* ---------- Mensaje inicial ---------- */

if (CONFIG.modo === 'recoleccion') {
  // El alias se pide como primer turno de la conversación, no como
  // campo aparte: no hay hueco en el layout para un input nuevo sin
  // tocar styles.css/index.html, y esto no lo necesita.
  agregarMensaje(
    'Antes de empezar, ¿con qué nombre o alias quieres que te identifique en esta conversación?',
    'bot'
  );
} else {
  agregarMensaje(
    'respuesta del Bot hacia el usuario cuando hace una pregunta',
    'bot'
  );
  agregarMensaje(
    'respuesta del usuario hacia el usuario  cuando hace una pregunta',
    'usuario'
  );
}

/* ============================================================
   Despliegue: CORS y qué cambia al salir de 127.0.0.1:4173
   ============================================================
   Headers que necesita el nodo Webhook / Respond to Webhook de n8n
   para que el fetch desde el navegador no sea bloqueado:

     Access-Control-Allow-Origin: <origen exacto del sitio desplegado>
       (o "*" mientras se prueba; en producción es mejor restringirlo
       al dominio real, p. ej. "https://augurio.tu-dominio.com")
     Access-Control-Allow-Methods: POST, OPTIONS
     Access-Control-Allow-Headers: Content-Type

   Algunos webhooks de n8n Cloud responden OPTIONS automáticamente;
   otros necesitan una rama explícita para el método OPTIONS que
   devuelva 200 con esos mismos headers y sin cuerpo (preflight).
   Si aparece un error de CORS en la consola al probar desde el sitio
   ya hospedado, es ahí donde hay que mirar primero.

   Qué cambia al dejar de servir desde 127.0.0.1:4173:
     - CONFIG.webhooks.* deben apuntar a las URLs reales de n8n
       (ya son alcanzables desde cualquier origen; eso no depende de
       dónde se hospede este front).
     - Si Access-Control-Allow-Origin queda fijo a un dominio (en vez
       de "*"), hay que actualizarlo cada vez que cambie el dominio
       real (producción, staging, dominio propio).
     - El id de sesión vive en localStorage, que es por origen: al
       mudarse de 127.0.0.1:4173 a un dominio real, los usuarios
       arrancan con una sesión nueva. Es el comportamiento esperado,
       no un bug.
     - Si los webhooks de n8n son https://, el sitio también debe
       servirse por https:// (contenido mixto: el navegador bloquea
       fetch http:// -> https:// y viceversa). GitHub Pages, Netlify
       y Vercel sirven https por defecto, así que normalmente no hay
       nada que hacer aquí, pero es la primera sospecha si el chat o
       las fichas fallan solo en producción.
     - El header "Cache-Control: no-store" de serve.py es una
       comodidad de desarrollo local. Un hosting real aplicará su
       propio cacheo; si después de un deploy el navegador sigue
       sirviendo un app.js viejo, es un tema de caché del hosting/CDN,
       no de este archivo.
   ============================================================ */

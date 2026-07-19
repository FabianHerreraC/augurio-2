# Augurio 2.0

Versión 2.0 de Augurio Colectivo. Sitio estático (sin build) conectado en producción a un backend de n8n + Supabase: chat con memoria por sesión y generación de fichas de análisis al terminar la conversación.

Publicado con GitHub Pages. Si `CONFIG.webhooks.chat` y `CONFIG.webhooks.fichas` se vacían en `app.js`, el sitio entero cae a modo demo con datos simulados (útil para iterar diseño sin depender del backend).

## Estructura

- `index.html` — layout: chat a la izquierda (fijo), Fichas 1 a 5 a la derecha (con scroll). Cada ficha tiene marco fijo: subtítulo "Objeto Consultivo", título, cuerpo y "2026".
- `styles.css` — sistema visual completo (paleta en las variables CSS de `:root`).
- `app.js` — toda la lógica: sesión, chat, polling de fichas, validación de contrato y modo demo. `CONFIG` al inicio del archivo es el único lugar con ajustes (URLs de webhooks, modo `'completo'`/`'recoleccion'`, timeouts).
- `assets/AuLogo.svg` — logo actual (wordmark "augurio." en crema). `AugurioLineas.svg` y `augurio-logo.svg` son versiones anteriores.
- `fonts/` — familia Helvena en OTF. Toda la tipografía usa Helvena (Light/Regular/Medium/Bold).
- `serve.py` — servidor estático local en `http://127.0.0.1:4173`, solo para desarrollo (GitHub Pages no lo usa).
- `.nojekyll` — desactiva el procesamiento Jekyll de GitHub Pages, para que assets y fuentes se sirvan tal cual.

## Paleta (tema oscuro)

| Color | Uso |
|---|---|
| `#000000` | fondo |
| `#F6ECC8` | tarjetas (crema), texto sobre negro |
| `#1F8EFF` | pills, botón de enviar, acentos |
| `#14140F` | texto sobre las tarjetas crema |

## Correr local

```
python3 serve.py
```

y abrir `http://127.0.0.1:4173`.

## Backend

Tres webhooks de n8n (`CONFIG.webhooks` en `app.js`): `chat`, `fichas` (arranca el análisis, responde `202` + `job_id`) y `estadoFichas` (sondeo hasta `listo` o `error`). El contrato de cada ficha es `{ id, tipo, html }`; el detalle completo está documentado en el comentario sobre `DUMMY_FICHAS` en `app.js`.

Si el dominio de despliegue cambia, hay que actualizar el *Allowed Origins* de los tres webhooks en n8n al nuevo dominio.

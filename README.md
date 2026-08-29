# Finanzas Personales

App de Node.js + Vercel para gestión financiera personal, con Google Sheets como base de datos. Portada originalmente desde una app de Google Apps Script (ver `reference-apps-script/`) y ampliada con varios módulos nuevos.

**Producción:** https://finanzas-si-ten.vercel.app

## Módulos

- **Inicio / Movimientos / Sueldos / Evolución** — finanzas personales: dashboard, carga de movimientos (importador de PDF Banco Galicia y Excel NBCH con categorización automática), seguimiento de sueldos y evolución mensual.
- **Inversiones** — dashboard por broker (Cocos Capital, BullMarket, Balanz, Banco Galicia USD): importador de movimientos, carga manual de saldos, importador de "fotos" de cartera (tenencias), composición de cartera y resultado por período.
- **Facturas IVA** — escanea una carpeta de Google Drive, analiza cada comprobante nuevo con IA (Gemini vision) y arma el registro de IVA. Detecta duplicados por Nro. de Factura + CUIT.
- **Mercado Pago** — el usuario sube el PDF "Resumen de cuenta" de Mercado Pago; se parsea 100% client-side con pdf.js (sin backend ni IA). Dashboard con evolución de saldo, categorización de gastos.
- **Quincho** — registro de gastos de una construcción (quincho), organizado en un árbol de etapas. Por etapa (solapas en orden **Pagos, Materiales, Presupuesto**): **Pagos** (con categoría Mano de Obra / Flete — el Flete suma al total gastado pero no descuenta del presupuesto de mano de obra; comprobante opcional de la transferencia/pago, analizado con IA para autocompletar fecha/monto/detalle y subido a Drive; el más reciente cargado aparece primero en la lista), **Materiales** (foto de comprobante analizada con IA, itemizada por producto, o carga manual; se sube a Drive) y **Presupuesto** (lo que pasa el contratista). Botón **🖨️ Imprimir / PDF** por etapa: abre una vista imprimible (detalle de presupuesto, detalle de pagos con fecha, y totales) para entregarle al contratista — usa `window.print()`, sin librería de PDF. Incluye un tablero de **Indicadores** con el resumen de todas las etapas (gráficos + tabla).
- **Usuarios** — alta/edición de usuarios y permisos por módulo (solo admin).

## Arquitectura

- **Datos**: todo vive en Google Sheets. La planilla principal (`SHEET_ID`) tiene una hoja por módulo (`📋 Registro`, `INVERSIONES`, `Facturas IVA`, `Mercado Pago`, `Usuarios`, etc.). El módulo Quincho usa una planilla **separada** (`QUINCHO_SHEET_ID`) con sus propias hojas (`Quincho Etapas`, `Quincho Materiales`, `Quincho Presupuesto`, `Quincho Pagos`).
- **Backend**: cada módulo tiene `lib/<modulo>.js` (funciones puras + acceso a Sheets/Drive/Gemini) y `api/<modulo>.js` (endpoint único enrutado por `?action=`, valida sesión y permisos antes de ejecutar). Esto mantiene el conteo de Serverless Functions bajo el límite del plan Hobby de Vercel (12) — **si se agrega un endpoint nuevo, sumarlo como una acción dentro de un archivo existente**, no como archivo nuevo, salvo que haga falta un módulo realmente nuevo.
- **Frontend**: todo en `views/index.html` (una sola página, sin build step). Usa un shim (`google.script.run` → `fetch`) que imita la API de Apps Script, para conservar casi intacta la lógica de negocio portada. Gráficos con Chart.js (CDN).
- **Login**: Google OAuth2/OIDC (`api/oauth.js`), cookie firmada con HMAC (`lib/auth.js`, sin guardar tokens). Permisos por módulo (`ninguno`/`lectura`/`escritura`) guardados en la hoja `Usuarios` de la planilla principal — se validan **en el servidor**, no solo ocultando UI.
- **IA**: Gemini API (gratis) para Facturas IVA y Materiales de Quincho, vía `fetch` directo (sin SDK), forzando JSON estructurado con `responseSchema`.
- **Drive**: el service account (`GOOGLE_CLIENT_EMAIL`) solo puede **leer** archivos de Drive — los service accounts no tienen cuota de almacenamiento propia y no pueden crear/subir archivos (Google devuelve `Service Accounts do not have storage quota`). Para que Quincho pueda subir fotos, se usa un **refresh token OAuth de la cuenta personal** (`GOOGLE_DRIVE_REFRESH_TOKEN`) en vez del service account — ver `lib/sheets.js` (`getDriveClientEscritura`).
- **`server.js`** (dev local): limpia todo `require.cache` en cada request para que los cambios en `lib/*.js`/`api/*.js` se reflejen sin reiniciar el proceso.

## Configuración

Copiar `.env.example` a `.env` y completar:

| Variable | Para qué |
|---|---|
| `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_PRIVATE_KEY_ID` | Service account (lee/escribe Sheets, solo lee Drive) |
| `SHEET_ID` | Planilla principal |
| `AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Login con Google |
| `ADMIN_EMAIL`, `ADMIN_NOMBRE` | Primer usuario admin (se siembra solo si la hoja `Usuarios` está vacía) |
| `GEMINI_API_KEY` (+ `GEMINI_MODEL` opcional) | IA para Facturas IVA y Materiales de Quincho |
| `FACTURAS_DRIVE_FOLDER_ID` | Carpeta de Drive con los comprobantes (compartida como Lector) |
| `QUINCHO_SHEET_ID` | Planilla propia de Quincho (compartida como Editor) |
| `QUINCHO_MATERIALES_FOLDER_ID` | Carpeta de Drive para fotos de materiales (compartida como Editor) |
| `QUINCHO_PAGOS_FOLDER_ID` | Carpeta de Drive para comprobantes de pago (compartida como Editor) |
| `GOOGLE_DRIVE_REFRESH_TOKEN` | Ver sección Drive arriba — se genera una única vez visitando `/api/oauth?action=drive-start` con el server corriendo y pegando el valor que devuelve |

Local: `node server.js` (puerto 3000, o `PORT=xxxx node server.js`).

## Deploy

```
git push origin main
vercel --prod
```

No hay integración Git↔Vercel; el deploy es siempre manual. Las env vars nuevas hay que agregarlas también en Vercel (`vercel env add NOMBRE production`), no alcanza con el `.env` local.

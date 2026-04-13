# Integración con Google Calendar

Guía para habilitar la API de Google Calendar, configurar la pantalla de consentimiento OAuth, crear credenciales de cliente web y definir las variables de entorno. Los tokens se guardan cifrados en `user_integrations` (misma clave que GitHub).

---

## 1. Proyecto y API en Google Cloud

1. Abre [Google Cloud Console](https://console.cloud.google.com/) y crea un proyecto o selecciona uno existente.

2. Ve a **APIs y servicios > Biblioteca**, busca **Google Calendar API** y pulsa **Habilitar**.

---

## 2. Pantalla de consentimiento OAuth

1. En **APIs y servicios > Pantalla de consentimiento de OAuth**, elige **Externo** (a menos que uses Workspace solo interno).

2. Completa nombre de la app, correo de soporte y dominios si Google lo pide.

3. En **Scopes**, añade el scope:

   `https://www.googleapis.com/auth/calendar.events`

   Permite crear, leer, actualizar y borrar eventos en los calendarios a los que el usuario te dé acceso (el producto usa el calendario **principal**).

4. Si la app queda en modo **Prueba**, añade tu cuenta (y las de prueba) en **Usuarios de prueba**; solo esas cuentas podrán conectar hasta que publiques la app.

---

## 3. Credenciales OAuth (cliente web)

1. Ve a **APIs y servicios > Credenciales > Crear credenciales > ID de cliente de OAuth**.

2. Tipo de aplicación: **Aplicación web**.

3. **Orígenes autorizados de JavaScript** (ejemplos):

   | Entorno    | Origen                         |
   | ---------- | ------------------------------ |
   | Local      | `http://localhost:3000`        |
   | Producción | `https://tu-dominio.com`       |

4. **URIs de redireccionamiento autorizados**:

   | Entorno    | URI                                                                 |
   | ---------- | ------------------------------------------------------------------- |
   | Local      | `http://localhost:3000/api/integrations/google/callback`            |
   | Producción | `https://tu-dominio.com/api/integrations/google/callback`           |

   Deben coincidir **exactamente** con la URL que usa el servidor (incluido el puerto en local).

5. Crea el cliente y copia el **ID de cliente** y el **Secreto del cliente**.

---

## 4. Variables de entorno

En `apps/web/.env.local` (o desde `apps/web/.env.example` como plantilla):

```env
# Google Calendar OAuth
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=tu-client-secret
# Recomendado si obtienes redirect_uri_mismatch (ver sección siguiente)
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3000/api/integrations/google/callback

# Misma clave que para GitHub: cifrado AES-256-GCM de tokens en base de datos
OAUTH_ENCRYPTION_KEY=tu-clave-de-64-caracteres-hex
```

| Variable                     | Descripción                                                                 |
| ---------------------------- | --------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`           | ID de cliente OAuth de tipo aplicación web.                                 |
| `GOOGLE_CLIENT_SECRET`       | Secreto del cliente. Solo en el servidor; nunca en el navegador.            |
| `GOOGLE_OAUTH_REDIRECT_URI`  | **Opcional.** URI completa del callback; debe ser **idéntica** a una de las URIs autorizadas en Google Cloud. Si no la defines, la app usa el `origin` de la petición + `/api/integrations/google/callback`, lo que puede fallar si entras con `127.0.0.1` pero en Google solo registraste `localhost` (o otro puerto/host). |
| `OAUTH_ENCRYPTION_KEY`       | 64 caracteres hex (32 bytes). Cifra el JSON de tokens (`access` + `refresh`). |

### Error 400: `redirect_uri_mismatch`

Google exige que el parámetro `redirect_uri` coincida **carácter por carácter** con una URI de la lista en la credencial OAuth.

Comprueba:

1. **Mismo host:** `http://localhost:3000` no es lo mismo que `http://127.0.0.1:3000`.
2. **Mismo puerto:** si la app corre en el puerto `3001`, la URI en Google debe usar `:3001`.
3. **http vs https** en local suele ser `http://`.
4. Sin barra final extra: path debe ser exactamente `/api/integrations/google/callback`.

Solución práctica: en Google Cloud añade **todas** las variantes que uses (localhost y 127.0.0.1 si aplica), **o** define `GOOGLE_OAUTH_REDIRECT_URI` en `.env.local` con la misma URI que copiaste en Google y **abre siempre la app con esa misma base URL** en el navegador (la cookie `state` del OAuth se asocia al host desde el que pulsaste “Conectar”; si mezclas `localhost` y `127.0.0.1`, el callback puede fallar por `state_mismatch`).

Para generar `OAUTH_ENCRYPTION_KEY`, usa la misma sección que en [Integración con GitHub](./github-integration.md#3-generar-la-clave-de-cifrado).

---

## 5. Flujo en el producto

1. El usuario entra en **Ajustes** y pulsa **Conectar Google Calendar** (`GET /api/integrations/google`).

2. El servidor guarda `state` en una cookie HttpOnly y redirige a Google con `access_type=offline` y `prompt=consent` para obtener **refresh_token** en la primera conexión.

3. Google devuelve el `code` al callback (`GET /api/integrations/google/callback`).

4. El servidor intercambia el `code`, construye un JSON con `access_token`, `refresh_token` y `expires_at`, lo cifra y hace upsert en `user_integrations` con `provider = google_calendar`.

5. En **Herramientas**, el usuario debe activar las herramientas de calendario que quiera usar en el agente.

---

## 6. Herramientas del agente y confirmaciones

| Herramienta                  | Descripción                         | Confirmación |
| ---------------------------- | ----------------------------------- | ------------ |
| `calendar_list_events`       | Lista eventos de un día (zona horaria) | No        |
| `calendar_create_event`      | Crea un evento en el calendario principal | Sí     |
| `calendar_cancel_event`      | Elimina un evento por `event_id`    | Sí           |
| `calendar_reschedule_event`  | Cambia inicio/fin de un evento      | Sí           |

Las acciones que modifican el calendario usan el mismo flujo de **confirmación humana** (HITL) que GitHub: el chat muestra el resumen y el usuario aprueba o rechaza antes de llamar a la API.

**Notas:**

- Para **crear** o **reagendar**, conviene usar fechas en **ISO 8601 con offset o Z** (ej. `2026-04-12T15:00:00-05:00`) para evitar ambigüedades de zona horaria.
- Los `event_id` salen de `calendar_list_events`.

---

## 7. Desconectar

En **Ajustes > Desconectar** se marca la integración como revocada y se intenta revocar el token en Google (`oauth2.googleapis.com/revoke`). El usuario también puede quitar el acceso en [Cuenta de Google > Seguridad > Acceso de terceros](https://myaccount.google.com/permissions).

---

## 8. Pruebas recomendadas

1. Conectar desde Ajustes y comprobar redirección `?google_calendar=connected`.

2. Preguntar al agente por las reuniones de un día concreto (debe listar sin pedir confirmación).

3. Pedir crear una reunión de prueba: debe aparecer confirmación; al **rechazar**, no debe crearse el evento; al **aprobar**, debe aparecer en Google Calendar.

4. Dejar pasar tiempo o forzar uso tras ~1 h: el servidor debe **refrescar** el access token con el refresh token sin que el usuario vuelva a conectar.

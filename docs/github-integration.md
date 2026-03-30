# Integración con GitHub

Guía para configurar la OAuth App de GitHub, las variables de entorno necesarias y la clave de cifrado de tokens.

---

## 1. Crear la OAuth App en GitHub

1. Ve a **Settings > Developer settings > OAuth Apps** en GitHub:
   <https://github.com/settings/developers>

2. Haz clic en **New OAuth App**.

3. Llena los campos:

   | Campo                        | Valor                                                      |
   | ---------------------------- | ---------------------------------------------------------- |
   | Application name             | El nombre de tu proyecto (ej. `Mi Agente Personal`)        |
   | Homepage URL                 | `http://localhost:3000` (o tu dominio en producción)       |
   | Authorization callback URL   | `http://localhost:3000/api/integrations/github/callback`   |

   En producción, reemplaza `http://localhost:3000` por tu dominio real con HTTPS.

4. Haz clic en **Register application**.

5. En la página de la app creada:
   - Copia el **Client ID**.
   - Haz clic en **Generate a new client secret** y copia el secreto generado.

---

## 2. Variables de entorno

Agrega las siguientes variables a `apps/web/.env.local` (puedes copiar desde `apps/web/.env.example`):

```env
# GitHub OAuth App
GITHUB_CLIENT_ID=tu-client-id
GITHUB_CLIENT_SECRET=tu-client-secret

# Clave de cifrado para tokens OAuth (AES-256-GCM)
OAUTH_ENCRYPTION_KEY=tu-clave-de-64-caracteres-hex
```

### Descripción de cada variable

| Variable               | Descripción                                                                 |
| ---------------------- | --------------------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`     | Client ID de la OAuth App en GitHub.                                        |
| `GITHUB_CLIENT_SECRET` | Client Secret de la OAuth App en GitHub. No debe exponerse al cliente.      |
| `OAUTH_ENCRYPTION_KEY` | Clave AES-256 en formato hexadecimal (64 caracteres = 32 bytes). Se usa para cifrar el token de GitHub antes de guardarlo en la base de datos. |

---

## 3. Generar la clave de cifrado

La clave `OAUTH_ENCRYPTION_KEY` debe ser un string hexadecimal de exactamente 64 caracteres (32 bytes). Puedes generarla con cualquiera de estos métodos:

### Con Node.js

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Con OpenSSL

```bash
openssl rand -hex 32
```

### Con Python

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

Cualquiera de los tres produce un resultado como:

```
a1b2c3d4e5f6...  (64 caracteres hex)
```

Copia el resultado y pégalo como valor de `OAUTH_ENCRYPTION_KEY` en tu `.env.local`.

> **Importante:** Esta clave no debe rotarse una vez que hay tokens cifrados en la base de datos, ya que no se podrían descifrar con una clave diferente. Si necesitas rotarla, primero descifra todos los tokens existentes con la clave vieja y vuelve a cifrarlos con la nueva.

---

## 4. Cómo funciona la integración

### Flujo OAuth

1. El usuario va a **Ajustes** y hace clic en **Conectar GitHub**.
2. La app redirige a GitHub (`GET /api/integrations/github`) con un parámetro `state` aleatorio guardado en una cookie HttpOnly.
3. El usuario autoriza la app en GitHub.
4. GitHub redirige al callback (`GET /api/integrations/github/callback`) con un `code` y el `state`.
5. El servidor valida el `state`, intercambia el `code` por un access token, lo cifra con AES-256-GCM y lo guarda en la tabla `user_integrations`.
6. El usuario vuelve a Ajustes con la conexión activa.

### Cifrado del token

- Algoritmo: `AES-256-GCM`
- El token se almacena en formato `iv:authTag:ciphertext` (todo en hex).
- Solo se descifra en el servidor cuando el agente necesita llamar a la API de GitHub.
- El token nunca se expone al cliente.

### Herramientas disponibles

Una vez conectado, el agente puede usar las siguientes herramientas con los permisos del usuario:

| Herramienta            | Descripción                          | Confirmación |
| ---------------------- | ------------------------------------ | ------------ |
| `github_list_repos`    | Lista repositorios del usuario       | No           |
| `github_list_issues`   | Lista issues de un repositorio       | No           |
| `github_create_issue`  | Crea un issue en un repositorio      | Si           |
| `github_create_repo`   | Crea un nuevo repositorio            | Si           |

Las herramientas que crean recursos requieren confirmación explícita del usuario mediante botones en la interfaz (web o Telegram) antes de ejecutarse.

### Desconectar

El usuario puede desconectar GitHub desde Ajustes. Esto marca la integración como `revoked` en la base de datos. El token cifrado se conserva pero deja de usarse. Para revocar el acceso completamente, el usuario también puede ir a <https://github.com/settings/applications> y revocar el acceso de la app desde GitHub.

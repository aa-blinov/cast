

# cast

Un arnés de agentes para terminal basado en roles. 20 perfiles integrados — desarrollador senior, QA, DBA, revisor de seguridad, PM, redactor técnico, y más — mismas herramientas, diferente criterio. Funciona con cualquier modelo compatible con OpenAI, incluido el que ejecutes en tu propio hardware.

<p align="center"><img src="assets/cast-banner.svg" alt="cast" width="440"></p>

## ¿Por qué cast?

**Un elenco, no un programador.** 20 perfiles integrados cambian el rol del agente sin modificar sus herramientas. Desarrollador senior para correcciones raíz, QA para casos extremos, DBA para diseño de esquemas, PM para especificaciones, appsec para modelado de amenazas — mismas herramientas, diferente criterio. Añade los tuyos con un solo archivo markdown.

**Herramientas reales, trabajo real.** Lee archivos, escribe código, ejecuta comandos en shell, busca en tu base de código — y lo hace todo en paralelo. Delega subtareas a subagentes aislados. Reglas, habilidades y servidores MCP extienden las capacidades sin tocar la base de código.

**Se ejecuta donde se ejecuta tu código.** vLLM, Ollama, tu propio servidor de inferencia o cualquier API compatible con OpenAI. Sin cuentas, sin telemetría, sin dependencia de la nube.

**Ink TUI.** Una interfaz de terminal completa con pegado multilinea, adjuntos de imágenes y animaciones fluidas.
**Interfaz Web.** `cast web` inicia una sala de control basada en navegador — agentes en segundo plano, transmisión token por token, visor de diferencias, todos los comandos con barra. Las mismas sesiones que en la TUI.

## ¿Por qué perfiles, no solo indicaciones?

Apunta un agente de programación genérico y uno específico por rol al mismo archivo, y no solo responden de forma diferente, sino que buscan cosas distintas. Dale a un perfil de appsec un esquema y señalará la superficie de inyección; dale a un perfil de DBA el mismo esquema y señalará índices faltantes y problemas de normalización. Un perfil de QA trata un caso extremo sin probar como trabajo incompleto; un perfil de PM trata una especificación no escrita como trabajo incompleto — mismo repositorio, mismas herramientas, diferente definición de "terminado".

Esto no es una simple capa visual. La investigación sobre indicación de roles/perfiles respalda este cambio por ambos lados de la brecha:

- Asignar a un LLM un rol de experto cambia mediblemente la *forma* de su salida — un enmarcado más profundo en el dominio a costa de cierta claridad en lenguaje llano, una compensación real y no una mejora gratuita ([Xiao et al., 2026](https://arxiv.org/abs/2605.29420)).
- El efecto no es un texto decorativo sin sustento: adaptar el perfil a la tarea ayuda, maladaptarlo perjudica, y un perfil mal adaptado rompe más respuestas de las que una coincidida arregla ([Kim et al., 2024](https://arxiv.org/abs/2408.08631)).
- Para agentes que usan herramientas específicamente, son las reglas explícitas de rol/comportamiento — no solo una etiqueta de perfil — las que corrigen la "acción insuficiente" (saltarse una herramienta que el rol debería usar obviamente) y el "exceso de habla" (chatear en lugar de ejecutar) ([Ruangtanusak et al., 2025](https://arxiv.org/abs/2509.00482)).
- El efecto no es universal — el enmarcado de perfiles ayuda más en tareas abiertas, consultivas y que requieren criterio, y menos en búsquedas factuales estrechas, por lo que un perfil solo vale la pena cuando coincide realmente con la tarea.

cast se apoya en esto en lugar de darle la vuelta: cambia `/persona` y las mismas herramientas, el mismo repositorio y el mismo modelo producirán una investigación distinta — prioridades diferentes, secuenciación de herramientas diferente, conclusiones diferentes, preguntas de seguimiento diferentes. Una revisión de seguridad que razona como un dev senior pasará por alto cosas distintas a una que razona como un ingeniero de appsec, incluso leyendo código idéntico.

Documentación completa, con citas directas y fuentes: [docs/persona-research.md](docs/persona-research.md).

## Instalación

macOS / Linux:

```bash
curl -fsSL https://aa-blinov.github.io/cast/install | bash
```

Windows (PowerShell):

```powershell
irm https://aa-blinov.github.io/cast/install.ps1 | iex
```

Requiere Node.js 22+. Paquete autocontenido: no se necesitan paquetes npm en tiempo de ejecución.

Fijar una versión: `CAST_VERSION=0.1.0 curl ... | bash`
Actualizar después: `cast upgrade`

## Inicio rápido

```bash
# Iniciar — solicita la URL del proveedor + clave API en la primera ejecución, la recuerda después
cast

# Indicador único
cast "explain what this project does"

# Modelo específico + razonamiento
cast -m qwen/qwen3-235b-a22b -r high "refactor this function"

# Reanudar última sesión
cast -c
```

## ¿Qué puede hacer?

### Herramientas integradas

`bash` `read` `write` `edit` `glob` `grep` `ls` `task` `ssh` `web_search` `web_fetch` — el agente tiene acceso completo al sistema de archivos, shell, SSH remoto y web. Varias herramientas se ejecutan en paralelo. La herramienta `task` delega trabajo a subagentes aislados (con su propio perfil y contexto) y solo devuelve el resultado final. Los archivos de imagen (jpg/png/gif/webp) se envían directamente a modelos con capacidad de visión. Las herramientas web están desactivadas por defecto — actívalas con `/web` (persiste en la configuración).

### Reglas

Instrucciones específicas del proyecto en `.cast/rules/*.md` — formato compatible con Cursor con cuatro modos: always (inyectado en cada turno), auto (adjuntado cuando archivos coincidentes entran en contexto), lazy (el modelo lo lee bajo demanda) y manual (vía `@mención` o `/rule:name`). Los directorios anidados `.cast/rules/` en subdirectorios acotan las reglas a ese subárbol.

### Archivos de contexto del proyecto

Coloca un `AGENTS.md` o `CLAUDE.md` en la raíz de tu repositorio — cast lo detecta automáticamente y lo inyecta en la indicación del sistema. Recorre todos los directorios ancestros hasta `/`, por lo que las directrices a nivel de organización en una carpeta padre se aplican a todos los proyectos debajo. El archivo en `cwd` mismo tiene restricción de confianza; los archivos superiores se cargan sin preguntar. Sin sintaxis especial, sin configuración — solo el archivo.

### Habilidades

Paquetes de instrucciones autocontenidos que se cargan bajo demanda desde `~/.cast/skills/` / `.cast/skills/`, además de rutas universales de skills.sh (`.agents/skills/`, `~/.config/agents/skills/`). Sigue la [especificación Agent Skills](https://agentskills.io). El agente ve qué hay disponible y carga la correcta automáticamente.

### Servidores MCP

Conecta cualquier servidor [Model Context Protocol](https://modelcontextprotocol.io) — local (stdio) o remoto (HTTP con streaming). Usa la forma común de configuración JSON `mcpServers`. Sus herramientas aparecen junto a las integradas.

### Perfiles

Cambia el rol del agente — y opcionalmente qué herramientas integradas puede usar ese rol:

| Perfil | Qué hace |
|---------|-------------|
| `coding` (predeterminado) | Lee archivos, ejecuta comandos, edita código |
| `coder-with-subagents` | Delega trabajo a subagentes vía la herramienta `task` para exploración paralela |
| `coder-with-subagents-force-review` | Programador que fuerza una revisión del perfil QA en cada resultado de subagente antes de aceptarlo |
| `senior` | Dev senior perezoso — correcciones raíz, eliminación sobre adición |
| `analyst` | Entrevistas a partes interesadas, síntesis de requisitos, análisis de brechas |
| `architect` | Diseño de sistemas — análisis de compensaciones, borradores de ADR, elección de dependencias |
| `pm` | Estrategia de producto, especificaciones, priorización |
| `product` | Operaciones de producto — notas de lanzamiento, banderas de característica, estrategia de despliegue |
| `qa` | Pruebas funcionales — características, casos extremos, regresiones |
| `qa-nfr` | No funcionales — rendimiento, seguridad, confiabilidad |
| `dba` | Bases de datos — diseño de esquemas, migraciones, optimización de consultas |
| `devops` | CI/CD, IaC, contenedores, Kubernetes, despliegues |
| `sre` | Confiabilidad del sitio — guardia, SLOs, respuesta a incidentes, capacidad |
| `sysadmin` | Operaciones — diagnostica sistemas, gestiona servicios |
| `appsec` | Seguridad de aplicaciones — modelado de amenazas, revisión segura de código |
| `tech-writer` | Documentación — READMEs, guías, referencias de API, registros de cambios |
| `marketer` | Posicionamiento, redacción, lanzamiento al mercado |
| `fiction-writer` | Ficción creativa, prosa, oficio literario |

Añade los tuyos en `~/.cast/personas/` (global) o `.cast/personas/` (proyecto).

### Modo plan

Pensar antes de construir: `/plan` cambia el agente a exploración de solo lectura — estudia la base de código (subagentes paralelos, shell de solo lectura) y escribe un plan de ejecución con una lista de verificación `- [ ]` en `~/.cast/plans/`. Cuando el plan está listo, aparece un diálogo de aprobación: implementar ahora, implementar en un contexto fresco, aprobar para después o seguir refinando. En modo construcción, el plan aprobado viaja en la indicación del sistema (sobreviviendo a la compactación y reinicios) y el agente marca pasos a medida que los completa. El agente también puede proponer planificar por sí mismo (`plan_enter`) cuando una tarea parece compleja. Cada fase puede ejecutar su propio modelo — ver `/plan-model`.

### Compactación de contexto

Cuando la conversación se vuelve demasiado larga, el agente resume automáticamente mensajes anteriores — mantiene la ventana de contexto útil sin perder detalles importantes.

### Niveles de razonamiento

Los modelos que lo soportan (metadatos de OpenRouter) obtienen controles de razonamiento: `off` / `low` / `medium` / `high` / `max`. Se establece vía `--reasoning` o se cambia en medio de la sesión con `/reasoning`.

### Sesiones

Cada conversación se guarda automáticamente. Reanuda con `--continue`, elige de una lista con `--resume`, o cambia en medio de la sesión con `/sessions`.

### Interfaz Web

`cast web` inicia una sala de control basada en navegador — las mismas sesiones que en la TUI, con visor de diferencias, agentes en segundo plano y transmisión token por token. La TUI sigue siendo la predeterminada para uso interactivo local; la Interfaz Web es la respuesta cuando quieres compartir una sesión, mantener una en ejecución en segundo plano o controlar cast desde un navegador/teléfono.

```bash
# Iniciar (predeterminado 127.0.0.1:1337)
cast web

# Iniciar en un puerto diferente
cast web --port 8080

# Vincular 0.0.0.0 para que sea accesible desde otras máquinas en la red
cast web --public

# Ciclo de vida
cast web status
cast web stop
```

Al primer inicio, cast genera automáticamente una contraseña y la guarda en `webPassword` dentro de `~/.cast/settings.json`. El usuario es siempre `cast`. La autenticación básica HTTP protege cada endpoint de la API — el navegador solicita la contraseña al cargar por primera vez. (Solicitud propia del navegador, no un formulario personalizado). La contraseña se muestra en la terminal en la primera ejecución para que puedas copiarla; después, búscala en `~/.cast/settings.json`.

La bandera `--public` imprime una advertencia explícita al vincular a `0.0.0.0` — la contraseña es lo único que separa tu máquina del resto de la red. Úsala en una LAN de confianza (o detrás de un proxy inverso / túnel) — nunca en una dirección pública.

Variables de entorno: `CAST_WEB_PORT` (predeterminado `1337`), `CAST_WEB_HOST` (predeterminado `127.0.0.1`).

## Comandos interactivos

| Comando | Descripción |
|---------|-------------|
| Cualquier texto | Enviar una indicación al agente |
| `/model [name]` | Mostrar/cambiar modelo |
| `/subagent-model [name]` | Mostrar/cambiar modelo del subagente |
| `/plan-model [name\|off]` | Mostrar/cambiar el modelo del modo plan |
| `/plan` | Entrar en modo plan (solo explorar + planificar) |
| `/build` | Salir del modo plan, restaurar juego completo de herramientas |
| `/reasoning` | Cambiar nivel de razonamiento |
| `/persona [name]` | Mostrar/cambiar perfil |
| `/provider` | Cambiar endpoint del proveedor y clave API |
| `/permissions [default\|bypass]` | Mostrar/cambiar modo de confirmación de bash |
| `/web` | Alternar herramientas web (web_search, web_fetch) |
| `/sessions` | Listar/cambiar/eliminar sesiones guardadas |
| `/skills` | Listar habilidades cargadas |
| `/skill:name [args]` | Forzar carga y ejecutar una habilidad |
| `/mcp` | Alternar servidores MCP on/off |
| `/reload` | Reescanear habilidades, reglas, MCP y perfiles para cwd |
| `/rules` | Listar reglas cargadas |
| `/rule:name` | Invocar una regla por nombre |
| `/steer <msg>` | Inyectar mensaje mientras el agente trabaja |
| `/s <msg>` | Alias para `/steer` |
| `/queue <msg>` | Poner mensaje en cola para después de que el agente pare |
| `/q <msg>` | Alias para `/queue` |
| `/queue-reset` | Borrar la cola de mensajes |
| `/qr` | Alias para `/queue-reset` |
| `/abort`, `/stop` | Detener ejecución actual del agente |
| `/compact` | Forzar compactación de contexto |
| `/new` | Iniciar una nueva sesión (guarda la actual automáticamente) |
| `/copy` | Copiar última respuesta del asistente al portapapeles |
| `/current` | Mostrar todos los datos de la barra de estado |
| `/clear` | Borrar contexto de la conversación |
| `/ssh` | Gestionar hosts SSH (listar, agregar, eliminar) |
| `/statusbar` | Alternar y reordenar segmentos de la barra de estado |
| `/theme` | Cambiar tema de color |
| `/usage` | Mostrar uso de tokens/costo de la sesión |
| `/repo` | Mostrar cwd y rama git |
| `/quit`, `/exit` | Guardar y salir |
| `/keys` | Listar todas las combinaciones de teclas |
| `/help` | Mostrar esta lista de comandos |

## Opciones de CLI

```
cast [options] [prompt]
  cast run [options] <message>   Modo no interactivo (transmite a stdout, sale)
  cast upgrade [version] [--force]
                                Vuelve a ejecutar el instalador para actualizar

Opciones:
  -m, --model <model>        Nombre del modelo
  -r, --reasoning <level>    off / low / medium / high / max
  -p, --persona <name>       Perfil a usar
  -c, --continue             Reanudar sesión más reciente
  --resume                   Elegir qué sesión reanudar (lista numerada)
  --resume=<id>              Reanudar sesión específica por id
  -s, --session <id>         Reanudar sesión específica (alias para --resume=<id>)
  --bypass-permissions       Omitir confirmación de comandos peligrosos
  --skill <path>             Cargar habilidad extra (repetible)
  --no-skills                Omitir descubrimiento de habilidades de proyecto/agentes/global/plugin/integradas
  --mcp <path>               Cargar configuración MCP extra (repetible)
  --no-mcp                   Omitir descubrimiento de servidores MCP global/proyecto
  -v, --version              Mostrar versión
  -h, --help                 Mostrar ayuda

Subcomando run:
  --format <default|json>    Formato de salida
  (también acepta: -m, -r, -p, -c, -s, --bypass-permissions, --skill, --mcp)
```

## Configuración del proveedor

En la primera ejecución, cast solicita tu URL de proveedor y clave API, y luego guarda ambos en `~/.cast/settings.json`. No se necesita archivo `.env`.

Otras variables de entorno (las credenciales del proveedor viven en el archivo de configuración, no en env):

| Variable | Descripción |
|----------|-------------|
| `CAST_CWD` | Anular directorio de trabajo |
| `CAST_BASH` | Ejecutable de bash para la herramienta `bash` (Windows: Git Bash no estándar / msys2) |
| `CAST_VERSION` | Fijar versión de instalación (instalador) |
| `CAST_WEB_PORT` | Puerto de `cast web` (predeterminado `1337`) |
| `CAST_WEB_HOST` | Dirección de vinculación de `cast web` (predeterminado `127.0.0.1`; usa `0.0.0.0` o `--public` para LAN) |

Funciona con cualquier cosa que hable la API de OpenAI: OpenRouter, OpenAI, Ollama (`http://localhost:11434/v1`), vLLM, LiteLLM, Azure OpenAI, etc.

## Arquitectura

```
src/
  core/           Lógica del agente (sin dependencia de UI)
    loop.ts         Bucle del agente — streaming, despacho de herramientas, compactación
    tools.ts        Definiciones de herramientas (formato de llamada de funciones OpenAI)
    tools/          Ejecutores de herramientas: bash, archivos, búsqueda, web, task
    llm.ts          Interacción con LLM, streaming, reintento, caché de indicaciones
    session.ts      Persistencia de sesión, estimación de tokens, compactación
    mcp.ts          Conexión con servidores MCP (stdio + HTTP con streaming)
    personas.ts     Carga de perfiles (proyecto > global > integrados)
    rules.ts        Sistema de reglas compatible con Cursor (always/auto/lazy/manual, reglas anidadas, @menciones)
    skills.ts       Implementación de la especificación Agent Skills
    config.ts       AppConfig, validación de modelos, incorporación
    project.ts      Ensamblaje de indicación del sistema, restricción de confianza
    startup.ts      Orquestación unificada de inicio
    runner.ts       Gestión de colas (orientación, seguimientos)
    run.ts          Ejecutor no interactivo (cast run)
    vendors.ts      Metadatos de razonamiento, análisis de bloques de pensamiento
    upgrade.ts      Autoactualización vía lanzamientos de GitHub
    ...
  ui/             Componentes de Ink TUI
    App.tsx         Diseño de nivel superior
    Composer.tsx    Entrada con autocompletado, pegado de imágenes
    ChatLog.tsx     Renderizado de mensajes
    commands.ts     Manejadores de comandos con barra
    ...
  pickers/        Selectores de incorporación (modelo, perfil, razonamiento)
  index.ts        Punto de entrada CLI

prompts/          Indicaciones del sistema, archivos de perfiles, plantillas de compactación
test/             Pruebas unitarias Vitest
scripts/          Paso de empaquetado esbuild
dist/             Paquete compilado de archivo único
```

## Desarrollo

```bash
npm install --ignore-scripts
npm start               # Ejecutar desde el código fuente (tsx)
npm run check           # Verificar tipos + lint (tsc + biome)
npm test                # Pruebas unitarias (vitest)
npm run build           # Empaquetar en dist/index.js (esbuild)
npm run format          # Formateo automático (biome)
npm run e2e:plan        # Humo e2e de modo plan vía tmux (proveedor real, cuesta tokens)
```

## Licencia

[MIT](LICENSE)

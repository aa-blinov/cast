# cast

Entorno de agentes para terminal basado en roles. Siete personas integradas cambian el criterio del agente sin alterar el conjunto de herramientas. Un mismo motor sirve a la interfaz de terminal, al navegador y a los scripts. Se conecta a cualquier endpoint compatible con OpenAI, incluso a uno que se ejecute en tu propio equipo.

![cast](assets/cast-banner.svg)

[![Licencia](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![CI](https://github.com/aa-blinov/cast/actions/workflows/ci.yml/badge.svg)](https://github.com/aa-blinov/cast/actions/workflows/ci.yml)
[![Versión](https://img.shields.io/github/v/release/aa-blinov/cast)](https://github.com/aa-blinov/cast/releases/latest)

---

## Inicio rápido

Node.js 22.12 o posterior es el único requisito de ejecución.

~~~bash
# macOS y Linux
curl -fsSL https://aa-blinov.github.io/cast/install | bash

# Windows, PowerShell
irm https://aa-blinov.github.io/cast/install.ps1 | iex
~~~

En macOS y Linux, el instalador extrae el archivo de la versión en <code>~/.cast/install</code> y crea un enlace simbólico desde <code>bin/cast</code> a <code>~/.local/bin</code>, que debe estar en <code>PATH</code>. En Windows, lo extrae en la carpeta <code>.cast\install</code> de tu directorio personal y añade su carpeta <code>bin</code> a la variable <code>PATH</code> de tu usuario. El archivo incluye el paquete y sus dependencias de ejecución, por lo que no hace falta ejecutar <code>npm install</code> después. Las sesiones aisladas también necesitan herramientas del sistema; consulta la [configuración del aislamiento](docs/sessions.md#sandbox-processes). Ambos instaladores abren el puerto 1337 en el firewall, donde escucha el servidor web.

~~~bash
cast                                   # abre la interfaz de terminal
cast "explica qué hace este proyecto"  # abre una sesión con un primer mensaje
cast -m qwen/qwen3-235b-a22b -r high "refactoriza esta función"
cast -c                                # reanuda la sesión más reciente
~~~

La primera vez, cast pide una persona, la URL del proveedor y una clave API, y después un modelo y un nivel de razonamiento. Todo se guarda en <code>~/.cast/settings.json</code>. No hace falta una cuenta ni un archivo <code>.env</code>.

| Plataforma | Archivo de distribución |
| --- | --- |
| macOS x64, macOS arm64 | <code>cast-&lt;version&gt;-darwin-x64.tar.gz</code>, <code>cast-&lt;version&gt;-darwin-arm64.tar.gz</code> |
| Linux x64, Linux arm64 | <code>cast-&lt;version&gt;-linux-x64.tar.gz</code>, <code>cast-&lt;version&gt;-linux-arm64.tar.gz</code> |
| Windows x64, Windows arm64 | <code>cast-&lt;version&gt;-win32-x64.zip</code>, <code>cast-&lt;version&gt;-win32-arm64.zip</code> |

Para fijar una versión, antepone <code>CAST_VERSION</code> al comando de instalación. Más tarde puedes actualizar con <code>cast upgrade</code>:

~~~bash
CAST_VERSION=0.58.0 curl -fsSL https://aa-blinov.github.io/cast/install | bash
~~~

## Qué hace

- **Siete personas, un mismo conjunto de herramientas.** <code>senior</code> (la predeterminada), <code>coder-with-subagents</code>, <code>analyst</code>, <code>pm</code>, <code>qa</code>, <code>researcher</code> y <code>assistant</code> cambian qué investiga el agente, qué prioriza y qué considera terminado. Cada persona es un archivo Markdown con metadatos al inicio. Sus listas de permisos (<code>tools</code>, <code>skills</code>, <code>mcp</code>, <code>subagents</code>, <code>subagentTypes</code>) se aplican durante la ejecución; no son solo instrucciones en el prompt. Solo <code>coder-with-subagents</code> activa la delegación.
- **Herramientas reales.** <code>bash</code>, <code>read</code>, <code>write</code>, <code>edit</code>, <code>glob</code>, <code>grep</code>, <code>ls</code>, <code>task</code>, <code>ssh</code>, <code>web_search</code>, <code>web_fetch</code> y otras: <code>memory</code>, <code>session_history</code>, <code>lsp</code>, <code>bash_output</code>, <code>bash_kill</code>, <code>todo_write</code>, <code>plan_done</code>, <code>question</code>, <code>review_report</code>, <code>goal_update</code>, <code>skill</code>, <code>skill_install</code>, <code>worktree</code> y <code>persona_create</code>. Las llamadas de la lista segura para ejecución paralela (<code>glob</code>, <code>grep</code>, <code>ls</code>, <code>lsp</code>, <code>memory</code>, <code>session_history</code>, <code>web_search</code>, <code>web_fetch</code>, <code>bash_output</code>) se ejecutan a la vez dentro de un mismo mensaje del asistente. Las llamadas al shell, las operaciones de escritura, las llamadas a <code>task</code> y MCP se ejecutan por orden para que una modificación no compita con otra llamada. El agente puede acceder al sistema de archivos, al shell, a SSH y a la web. Los archivos de imagen (jpg, png, gif, webp) se envían directamente a un modelo con capacidad de visión. Las herramientas web están desactivadas hasta que las actives con <code>/web</code>; la opción queda guardada en la configuración.
- **Usa tu propio modelo.** OpenRouter, OpenAI, Ollama (<code>http://localhost:11434/v1</code>), vLLM, LiteLLM, Azure OpenAI o cualquier endpoint que implemente la API Chat Completions de OpenAI. La URL del proveedor y la clave se guardan en <code>~/.cast/settings.json</code>. No requiere cuentas, no recopila telemetría y no depende de la nube.
- **Una interfaz de terminal que controla su desplazamiento.** Interfaz a pantalla completa basada en [pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui): la rueda, el panel táctil, Re Pág, Av Pág y la búsqueda permiten recorrer la conversación, y el redibujado no te devuelve al final. Admite pegar varias líneas, adjuntar imágenes y ver subagentes. Se adapta tanto a una pantalla pequeña como a un monitor panorámico. Consulta [La interfaz de terminal](docs/terminal-ui.md).
- **Un centro de control en el navegador.** <code>cast web</code> sirve las mismas sesiones por HTTP y SSE, con transmisión token a token, visor de diferencias, agentes en segundo plano, pestaña de archivos y comandos de chat. Configuración incluye controles de cuenta y proyecto. <code>cast server</code> es un alias para scripts e integraciones que usan el daemon.
- **Sesiones persistentes.** Cada conversación se guarda en SQLite en <code>~/.cast/sessions/sessions.db</code>. Reanuda con <code>--continue</code>, elige una con <code>--resume</code>, cambia a otra durante la sesión con <code>/sessions</code>, crea una rama con <code>/fork</code> y revierte un turno con <code>/undo</code> o <code>/rewind</code>.
- **Memoria entre sesiones.** Memoria de proyecto persistente en <code>~/.cast/memory/</code>, con un índice de texto completo de SQLite derivado de esos archivos. Cuando una sesión se acerca al límite de contexto, un proceso de puntos de control actualiza los archivos de traspaso.
- **Modo de planificación.** <code>/plan</code> deja al agente en modo de solo lectura. Explora, escribe un plan con una lista de tareas <code>- [ ]</code> en <code>&lt;project&gt;/.cast/plans/&lt;session-id&gt;/</code> y llama a <code>plan_done</code>. Después puedes seguir puliendo el plan, implementarlo en el contexto actual o hacerlo en uno limpio. <code>/build</code> devuelve el plan al modo de implementación. Los planes aprobados vuelven a cargarse en el contexto de construcción después de una compactación o un reinicio, y sus tareas aparecen en la lista de tareas.
- **Compactación del contexto.** Cuando la conversación se alarga demasiado, el agente resume los mensajes antiguos para conservar los detalles importantes y mantener espacio para continuar.
- **Niveles de razonamiento.** El control combina los metadatos del modelo del proveedor con el dialecto configurado. Algunos proveedores ofrecen <code>off</code> y <code>on</code>; otros, niveles como <code>low</code>, <code>medium</code> y <code>high</code>. Usa <code>--reasoning</code>, <code>/reasoning</code> y <code>/reasoning-format</code> para configurarlos; la última opción sirve para endpoints que necesitan un protocolo explícito.
- **Reglas, habilidades y servidores MCP.** Las reglas del proyecto se guardan en <code>.cast/rules/*.md</code> y usan un formato compatible con Cursor con cuatro modos: <code>always</code> (se incluyen en cada turno), <code>auto</code> (se adjuntan cuando los archivos coincidentes entran en contexto), <code>lazy</code> (el modelo las lee cuando las necesita) y <code>manual</code> (mediante <code>@mention</code> o <code>/rule:name</code>). Las reglas anidadas limitan su ámbito al subárbol correspondiente. Las habilidades pueden cargarse desde <code>~/.cast/skills/</code> y <code>.cast/skills/</code>, además de las rutas universales de skills.sh (<code>.agents/skills/</code>, <code>~/.agents/skills/</code>, <code>~/.config/agents/skills/</code>), y siguen la [especificación Agent Skills](https://agentskills.io). Los servidores MCP se conectan por stdio o HTTP con streaming mediante la configuración JSON habitual <code>mcpServers</code>. Sus herramientas aparecen junto a las integradas con nombres como <code>mcp_&lt;server&gt;_&lt;tool&gt;</code>.
- **Archivos de contexto del proyecto.** Añade un <code>AGENTS.md</code> o <code>CLAUDE.md</code> a la raíz del repositorio y cast lo incluirá en el prompt del sistema. Recorre los directorios ascendentes hasta <code>/</code>, así que las directrices de una organización guardadas en una carpeta superior se aplican a los proyectos que contiene. El archivo del directorio de trabajo requiere aprobación de confianza; los archivos superiores se cargan sin preguntar. No hace falta sintaxis especial ni configuración.

### Personas

| Persona | Función |
|---------|-------------|
| <code>senior</code> (predeterminada) | Desarrollador sénior: busca la causa raíz, prefiere eliminar antes que añadir y verifica antes de confirmar cambios |
| <code>coder-with-subagents</code> | Delega la exploración en subagentes mediante la herramienta <code>task</code> |
| <code>analyst</code> | Trabajo de producto, análisis y proyectos: hipótesis, decisiones, requisitos, prioridades y planes |
| <code>pm</code> | Convierte decisiones acordadas en planes, hitos, dependencias y tareas concretas |
| <code>qa</code> | Revisión funcional: requisitos, regresiones, escenarios y hallazgos accionables |
| <code>researcher</code> | Investigaciones respaldadas por fuentes, búsquedas, comprobaciones cruzadas y citas |
| <code>assistant</code> | Ayuda cotidiana, planificación, redacción y consultas rápidas; usa herramientas cuando la tarea lo requiere |

Añade tus propias personas en <code>~/.cast/personas/</code> (global) o <code>.cast/personas/</code> (proyecto), o pídele al agente que cree una. El asistente configura su comportamiento, las herramientas integradas, las habilidades, los servidores MCP, los subagentes y <code>agentsMd</code>, y muestra el cambio propuesto antes de escribirlo. Si editas la persona activa, el turno actual no cambia; la modificación se aplica al mensaje siguiente y no hace falta ejecutar <code>/reload</code>.

La limitación de capacidades es opcional. Las personas incluidas conservan las herramientas, habilidades y servidores MCP habituales para que cambiar de rol no desactive flujos de trabajo. Una persona sin una lista de permisos sigue teniendo acceso a todas las herramientas. Define una lista en una persona propia cuando necesites limitar el acceso o reducir el prompt, por ejemplo, para que un rol de documentación no pueda usar el shell ni las herramientas de base de datos. Consulta [Personas](docs/personas.md) e [Investigación sobre personas](docs/persona-research.md).

## Comandos interactivos

| Comando | Descripción |
|---------|-------------|
| Cualquier texto | Envía un prompt al agente |
| <code>/model [name]</code> | Muestra o cambia el modelo |
| <code>/subagent-model [name]</code> | Muestra o cambia el modelo de los subagentes |
| <code>/plan-model [name&#124;off]</code> | Muestra o cambia el modelo del modo de planificación |
| <code>/plan-model-provider [name&#124;off]</code> | Configura el proveedor del modelo de planificación |
| <code>/plan</code> | Activa el modo de planificación, solo para explorar y planificar |
| <code>/build</code> | Sale del modo de planificación y restaura todas las herramientas |
| <code>/reasoning</code> | Cambia el nivel de razonamiento |
| <code>/reasoning-format</code> | Elige el protocolo de razonamiento del proveedor |
| <code>/persona [name]</code> | Muestra o cambia la persona |
| <code>/provider</code> | Cambia el endpoint del proveedor y la clave API |
| <code>/permissions [default&#124;bypass]</code> | Muestra o cambia el modo de confirmación para Bash |
| <code>/web</code> | Activa o desactiva las herramientas web (<code>web_search</code>, <code>web_fetch</code>) |
| <code>/web-fetch-provider</code> | Elige Jina Reader o la descarga local directa |
| <code>/sessions</code> | Lista, cambia o elimina sesiones guardadas |
| <code>/fork</code> | Crea una sesión derivada con todo el contexto o desde antes de uno de tus mensajes; en la interfaz web también puedes hacerlo desde la respuesta de un agente |
| <code>/undo</code> | Revierte el último turno: restaura los archivos y lo elimina de la conversación |
| <code>/rewind</code> | Vuelve a antes de un mensaje elegido: en los archivos, la conversación o ambos |
| <code>/skills</code> | Muestra las habilidades cargadas |
| <code>/skill:name [args]</code> | Carga y ejecuta una habilidad |
| <code>/mcp</code> | Activa o desactiva los servidores MCP |
| <code>/hooks</code> | Lista y activa o desactiva los hooks del ciclo de vida |
| <code>/reload</code> | Vuelve a analizar habilidades, reglas, MCP y personas para el directorio actual |
| <code>/rules</code> | Lista las reglas cargadas |
| <code>/rule:name</code> | Ejecuta una regla por nombre |
| <code>/steer &lt;msg&gt;</code> | Envía un mensaje al agente mientras trabaja |
| <code>/s &lt;msg&gt;</code> | Alias de <code>/steer</code> |
| <code>/queue &lt;msg&gt;</code> | Añade un mensaje para cuando termine el agente |
| <code>/q &lt;msg&gt;</code> | Alias de <code>/queue</code> |
| <code>/queue-reset</code> | Vacía la cola de mensajes |
| <code>/qr</code> | Alias de <code>/queue-reset</code> |
| <code>/abort</code>, <code>/stop</code> | Detiene la ejecución del agente |
| <code>/compact</code> | Fuerza la compactación del contexto |
| <code>/new</code> | Inicia una sesión y guarda automáticamente la actual |
| <code>/copy</code> | Copia al portapapeles la última respuesta |
| <code>/current</code> | Muestra todos los datos de la barra de estado |
| <code>/clear</code> | Borra el contexto de la conversación |
| <code>/ssh</code> | Administra hosts SSH: lista, añade o elimina |
| <code>/statusbar</code> | Activa segmentos de la barra de estado y cambia su orden |
| <code>/theme</code> | Cambia el tema de color |
| <code>/usage</code> | Muestra el uso y el coste de la sesión |
| <code>/repo</code> | Muestra el directorio de trabajo y la rama de Git |
| <code>/quit</code>, <code>/exit</code> | Guarda y cierra |
| <code>/keys</code> | Muestra los atajos de teclado |
| <code>/help</code> | Muestra esta lista de comandos |

La paleta de la terminal muestra todos los comandos, incluidos los que no aparecen en esta tabla. [Comandos interactivos](docs/interactive-commands.md) contiene la referencia completa.

## Línea de comandos

~~~text
cast [options] [prompt]
  cast run [options] <message>   Modo no interactivo (transmite a stdout y termina)
  cast run --interactive         Sesión JSONL persistente para clientes programáticos
  cast web [start|stop|status]   Centro de control en el navegador
  cast server [start|stop|status]  Alias de cast web
  cast upgrade [version] [--force]
                                Vuelve a ejecutar el instalador para actualizar
  cast shell-init [zsh|bash|fish]
                                Función de shell que guarda el comando de reanudación en el historial
  cast requests <session> [n]   Qué recibió el modelo
  cast lsp <operation> <file> [...]  Consulta un servidor de lenguaje, como la herramienta lsp

Opciones:
  -m, --model <model>        Nombre del modelo
  -r, --reasoning <level>    off / low / medium / high / max
  -p, --persona <name>       Persona que se usará
  -c, --continue             Reanuda la sesión más reciente
  --resume                   Elige la sesión que quieres reanudar
  --resume=<id>              Reanuda la sesión con este id
  -s, --session <id>         Reanuda la sesión (alias de --resume=<id>)
  -w, --worktree <name>      Ejecuta en un worktree de Git aislado
  --bypass-permissions       Omite las confirmaciones (alias: --dangerously-skip-permissions)
  --skill <path>             Carga una habilidad adicional (se puede repetir)
  --no-skills                Omite la búsqueda de habilidades del proyecto, agentes, globales, plugins e integradas
  --mcp <path>               Carga configuración MCP adicional (se puede repetir)
  --no-mcp                   Omite la detección de servidores MCP globales y del proyecto
  -v, --version              Muestra la versión
  -h, --help                 Muestra la ayuda

Subcomando run:
  --format <default|json>    Formato de salida
  --interactive              Protocolo de sesión JSONL persistente
  --keep-background          Deja en ejecución las tareas en segundo plano cuando termina run
  (también acepta: -m, -r, -p, -c, -s, -w, --bypass-permissions, --skill, --mcp)
~~~

Consulta [Referencia de la CLI](docs/cli-reference.md) para ver todos los flags y subcomandos.

## Cómo funciona

Un motor, tres formas de acceder. <code>runAgentLoop</code> en <code>src/core/loop.ts</code> es el único lugar donde se ejecuta un turno.

~~~text
TUI  -+
      +- HTTP + SSE -> daemon del servidor cast -> runAgentLoop -> LLM, herramientas, MCP
Web  -+
~~~

El daemon ejecuta <code>runAgentLoop</code> para cada sesión y es el único proceso que escribe en el almacén de sesiones. Si no hay uno activo, la interfaz de terminal inicia un daemon en loopback y se comunica con él mediante la misma API REST y SSE que usa el navegador. Una sesión abierta en ambas interfaces transmite tokens, llamadas a herramientas y estado a las dos; si detienes el turno desde cualquiera de ellas, se detiene en ambas.

Durante un turno, el motor transmite la respuesta del modelo, ejecuta las herramientas que este solicita, añade los resultados y vuelve a llamar al modelo. Las llamadas de la lista segura para ejecución paralela se ejecutan a la vez dentro de un mismo mensaje del asistente. Los comandos de shell, las escrituras, las llamadas a <code>task</code> y MCP se ejecutan por orden para evitar que una modificación compita con otra llamada. Cuando el historial supera el límite de compactación, los turnos antiguos se resumen y el corte se ajusta a los límites entre turnos para mantener juntas cada llamada a una herramienta y su resultado.

Cada cambio de estado genera un evento. El daemon los convierte en mensajes SSE, y la interfaz de terminal, el navegador y <code>cast run</code> muestran ese mismo flujo, en lugar de volver a calcular el estado por separado.

| Guía | Contenido |
| --- | --- |
| [Arquitectura](docs/architecture.md) | Estructura del código y decisiones de diseño. |
| [Infraestructura](docs/infrastructure.md) | Daemon, clientes, ciclo de vida y autenticación. |
| [La interfaz de terminal](docs/terminal-ui.md) | Lectura, escritura, desplazamiento y selección en la TUI. |
| [La interfaz web](docs/web-ux.md) | Cliente de navegador: superficies, flujos y diseño adaptable. |
| [Herramientas](docs/tools.md) | Herramientas integradas, parámetros y límites. |
| [Personas](docs/personas.md) | Las siete personas integradas y cómo crear otras. |
| [Reglas](docs/rules.md) | Los cuatro modos de reglas y la estructura anidada. |
| [Habilidades](docs/skills.md) | Especificación Agent Skills y ubicaciones de carga. |
| [Servidores MCP](docs/mcp-servers.md) | Configuración de servidores MCP locales y remotos. |
| [Sesiones](docs/sessions.md) | Almacenamiento, reanudación, registro de solicitudes y área temporal. |
| [Memoria](docs/memory.md) | Archivos de memoria, índice de búsqueda y comandos. |
| [Modo de planificación](docs/plan-mode.md) | Restricción de solo lectura y archivos de planes. |
| [Configuración](docs/configuration.md) | Ajustes, variables de entorno y permisos. |
| [API v1](docs/api.md) | Contrato HTTP y SSE del daemon y documento OpenAPI. |
| [Todas las guías](docs/index.md) | Índice completo. |

## Configuración

Los ajustes del usuario se guardan en <code>~/.cast/settings.json</code>. Se cargan al iniciar y se escriben de forma atómica para que un fallo durante la escritura no corrompa el archivo.

| Ajuste | Valor predeterminado | Descripción |
| --- | --- | --- |
| <code>model</code>, <code>modelProvider</code> | De la primera ejecución | Modelo y proveedor guardado al que pertenece. |
| <code>persona</code> | <code>senior</code> | Persona con la que comienzan las sesiones nuevas. |
| <code>providerUrl</code>, <code>apiKey</code> | De la primera ejecución | Endpoint activo y su clave. |
| <code>providers</code> | Ninguno | Proveedores guardados: <code>name</code>, <code>url</code>, <code>apiKey</code> y <code>reasoningFormat</code> opcional. |
| <code>reasoningLevel</code> | <code>off</code> | Nivel de razonamiento. |
| <code>contextWindow</code> | <code>128000</code> o el valor del catálogo del modelo | Ventana que se usa para calcular el presupuesto. |
| <code>maxResponseTokens</code> | <code>32000</code> | Tokens reservados para la respuesta del modelo. |
| <code>compactionThreshold</code> | <code>0.75</code> | Fracción del presupuesto disponible que activa la compactación. |
| <code>maxTurnIterations</code> | <code>500</code> | Límite de seguridad de llamadas al modelo por turno. |
| <code>maxToolOutputLines</code> | <code>2000</code> | Límite de líneas de cada resultado de herramienta. |
| <code>maxToolOutputBytes</code> | <code>131072</code> | Límite de bytes de cada resultado de herramienta. |
| <code>webTools</code> | <code>false</code> | Indica si se anuncian <code>web_search</code> y <code>web_fetch</code>. |
| <code>autoFormat</code> | <code>true</code> | Ejecuta el formateador del proyecto después de cada <code>write</code> o <code>edit</code>. |
| <code>lsp</code> | <code>true</code> | Informa de errores del servidor de lenguaje después de cada escritura. |
| <code>lspAutoInstall</code> | <code>true</code> | Instala servidores de lenguaje de npm en <code>~/.cast/lsp</code> al usarlos por primera vez. |
| <code>notifications</code> | <code>true</code> | Muestra una notificación en la terminal y un sonido al terminar un turno. |
| <code>scratchpad</code> | <code>true</code> | Crea una carpeta temporal para cada sesión. |
| <code>memoryEnabled</code> | <code>true</code> | Activa la memoria persistente del proyecto y su recuperación. |
| <code>permissions</code> | Ninguno | Reglas por herramienta: <code>allow</code>, <code>ask</code>, <code>deny</code> y <code>approved</code>. |
| <code>projectTrust</code> | Ninguno | Decisión de confianza para cada proyecto. |
| <code>serverToken</code> | Generado | Contraseña que solicita la interfaz web. |

Variables de entorno:

| Variable | Descripción |
|----------|-------------|
| <code>CAST_CWD</code> | Sobrescribe el directorio de trabajo |
| <code>CAST_BASH</code> | Ejecutable Bash para la herramienta <code>bash</code> (en Windows: Git Bash o msys2 no estándar) |
| <code>CAST_VERSION</code> | Fija la versión del instalador |
| <code>CAST_SERVER_PORT</code> | Puerto del daemon del servidor (predeterminado: <code>1337</code>) |
| <code>CAST_SERVER_HOST</code> | Dirección de escucha del daemon (predeterminada: <code>127.0.0.1</code>; usa <code>0.0.0.0</code> o <code>--public</code> para la red local) |
| <code>CAST_SESSIONS_DB</code> | Sobrescribe la ruta de la base SQLite de sesiones |
| <code>CAST_NO_DAEMON</code> | Ejecuta el motor en el proceso de terminal en lugar de usar el daemon |

Las credenciales del proveedor solo se guardan en el archivo de ajustes. cast no lee <code>PROVIDER_BASE_URL</code>, <code>PROVIDER_API_KEY</code> ni un archivo <code>.env</code> del proyecto; editar esos valores no cambia nada.

Archivos del disco:

~~~text
~/.cast/
  settings.json         # Ajustes del usuario
  sessions/sessions.db  # Almacén de sesiones
  memory/               # Memoria persistente del proyecto
  scratch/<session id>/ # Área temporal de cada sesión
  skills/  rules/  personas/  mcp.json

<project>/.cast/
  plans/<session-id>/   # Planes de sesión
  skills/  rules/  personas/
  mcp.json  hooks.json  ssh.json
~~~

### El servidor web

~~~bash
cast web                 # Inicia (predeterminado: 127.0.0.1:1337)
cast web --port 8080     # Inicia en otro puerto
cast web --public        # Escucha en 0.0.0.0 para permitir el acceso desde otros equipos
cast web status          # Comprueba si está en ejecución
cast web stop            # Lo detiene
~~~

Al iniciarlo por primera vez, cast genera una contraseña, la muestra en la terminal y la guarda como <code>serverToken</code> en <code>~/.cast/settings.json</code>. El nombre de inicio de sesión siempre es <code>cast</code>. El servidor muestra su propia pantalla de acceso con el tema de la aplicación y guarda la sesión en una cookie <code>HttpOnly</code> y <code>SameSite</code>; las respuestas de la API nunca se almacenan en caché.

La opción <code>--public</code> expone HTTP sin cifrar. Úsala solo en una red local de confianza: no protege la contraseña ni la sesión frente a quienes puedan observar el tráfico. Para acceder desde fuera sin dominio ni HTTPS, deja cast en la dirección de loopback predeterminada y usa un túnel SSH: <code>ssh -L 1337:127.0.0.1:1337 user@host</code>.

El daemon guarda su dirección de escucha, un token local para la TUI y una identidad por proceso en <code>~/.cast/server.json</code>. La TUI del mismo equipo se conecta a <code>127.0.0.1</code> incluso si el daemon usa <code>--public</code>, y el token solo se acepta desde una conexión de loopback. Las sesiones inactivas sin clientes conectados se liberan de la memoria del daemon después de cinco minutos y se vuelven a cargar desde el almacén al abrirlas.

<code>cast upgrade</code> comprueba la identidad del daemon antes de reiniciarlo y conserva el host y el puerto. Los daemons en primer plano no se reinician automáticamente: hazlo manualmente después de actualizar para no interrumpir el trabajo que controlan sus terminales.

## Desarrollo

~~~bash
npm install --ignore-scripts  # instala las dependencias
npm start                     # ejecuta desde el código fuente mediante tsx
npm run check                 # tsc --noEmit y biome check src/ test/
npm test                      # ejecuta la suite de Vitest
npm run build                 # genera dist/index.js con esbuild
npm run format                # biome format --write
npm run coverage              # ejecuta Vitest con cobertura v8
npm run coverage:check        # comprueba el mínimo de cobertura por archivo
npm run e2e:plan              # prueba rápida del modo de planificación en tmux con un proveedor real
~~~

<code>npm install --ignore-scripts</code> omite el hook <code>prepare</code>, que instala los hooks de Git. Ejecuta <code>npm run hooks:install</code> para instalarlos manualmente. La suite contiene 243 archivos de Vitest, nombrados según el módulo que prueban, y no realiza llamadas reales a proveedores: las pruebas usan valores falsos de <code>baseURL</code> y <code>apiKey</code>. La excepción es <code>test/mcp.test.ts</code>, que inicia un servidor local de prueba.

| Ruta | Contenido |
| --- | --- |
| <code>src/core/</code> | Motor: bucle del agente, herramientas, cliente LLM, sesiones, configuración, MCP, habilidades y personas. |
| <code>src/core/acp/</code> | Puente JSON-RPC para Agent Client Protocol. |
| <code>src/ui/</code> | Comportamiento de la interfaz de terminal compartido con el servidor web. |
| <code>src/ui-pi/</code> | Interfaz pi-tui: conversación, editor, modales y barra de estado. |
| <code>src/server/</code> | Daemon, puente REST y SSE, cliente del navegador. |
| <code>src/pickers/</code> | Selectores iniciales de modelo, persona y razonamiento. |
| <code>prompts/</code> | Prompts del sistema, archivos de personas y plantillas de compactación. |
| <code>test/</code> | Suite de Vitest. |
| <code>evals/</code> | Ejecutor de evaluaciones de comportamiento y resultados versionados. |
| <code>scripts/</code> | Compilación, sitio de documentación y scripts de extremo a extremo. |
| <code>docs/</code> | Guías, una por tema. |

## Licencia

MIT, © 2026 aa-blinov. Consulta [LICENSE](LICENSE).

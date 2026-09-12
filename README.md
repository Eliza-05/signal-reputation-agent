# Monitor de reputación

Un agente de Slack que vigila lo que internet dice de una empresa y saca a la luz los problemas mientras todavía son pequeños.

Construido sobre el [starter kit de Agents, Everywhere](https://github.com/CopilotKit/agents-everywhere-starter-kit) (CopilotKit Channels + OpenRouter + Exa).

---

## El problema

Las quejas de los clientes no llegan por un solo sitio. Llegan al foro oficial, a Reddit, a Trustpilot, a un hilo en portugués que nadie del equipo lee, y a un post de LinkedIn en alemán. Para cuando alguien conecta los puntos y se da cuenta de que cinco personas describen el mismo fallo, ya es tarde.

El agente hace esa conexión. Busca en cuatro idiomas, traduce, agrupa las quejas que describen **el mismo fallo funcional** aunque estén escritas de forma distinta y en idiomas distintos, y avisa cuando un grupo cruza el umbral de incidente.

## El canal es el espacio de trabajo, no solo la salida

Esto es lo que lo diferencia de un scraper con notificaciones.

El equipo pega quejas en el canal —texto o enlaces— y **entran al análisis con el mismo peso** que las que encuentra el agente por su cuenta. Eso cubre las redes sociales y las comunidades cerradas sin pagar acceso a sus APIs: el humano descubre, el agente analiza.

Quitar el canal no degrada al agente, lo deja ciego a la mitad de la evidencia.

## Cómo se usa

Menciónalo con el nombre de una empresa y el idioma en que quieres la respuesta:

```
@monitordereputacion2 analiza la reputación de Zapier en español
```

O aliméntalo primero y pídele el análisis después:

```
@monitordereputacion2 voy a pegarte unas quejas, espera
```
```
Cancelé mi suscripción y me siguieron cobrando.
I was double billed this month.
Ich wurde nach der Kündigung erneut belastet.
```
```
@monitordereputacion2 ahora analiza Zapier en español
```

> **Importante: menciona al bot ANTES de pegar las quejas.** Ver [Limitaciones conocidas](#limitaciones-conocidas).

Responde con una tarjeta nativa de Slack: los grupos ordenados por urgencia, los incidentes primero, con enlaces a cada fuente original. Cuando un grupo cruza el umbral, ofrece escalarlo a una tarea con un clic.

## Cómo funciona

```
menciones del canal ─┐
                     ├─→ clasificar ─→ agrupar ─→ ¿incidente? ─→ tarjeta en Slack
barrido web (Exa) ───┘    (modelo)    (modelo)   (código puro)
```

**1. Recopilar.** Seis consultas en cuatro idiomas (3 en inglés, 1 español, 1 portugués, 1 alemán), rotando entre problemas técnicos, facturación y soporte. Más lo que el equipo pegó en el canal.

**2. Clasificar.** Cada mención por separado: resumen traducido al idioma objetivo, categoría, prioridad, y un `problema_nucleo` **siempre en inglés y genérico**. Ese campo es lo único que el agrupamiento compara, y es lo que permite emparejar una queja en alemán con su gemela en portugués.

**3. Agrupar.** El modelo decide una sola cosa: qué menciones describen el mismo fallo. El criterio es *"¿el mismo arreglo resolvería ambas?"*. Todo lo contable —fuentes distintas, fechas— se calcula en código, porque esos números alimentan la regla de incidente y un modelo al que le pides contar se equivoca de formas que nadie nota.

**4. Decidir.** Sin modelo. Tres condiciones obligatorias, en `incident-config.ts`:

| condición | por defecto |
|---|---|
| menciones mínimas | 3 |
| dominios distintos mínimos | 2 |
| la más reciente, dentro de | 48 h |

"Esto es un incidente" es la afirmación que hace que alguien suelte lo que está haciendo. Tiene que ser reproducible e inspeccionable, y dar el mismo resultado en cada corrida.

### Decisiones de diseño que conviene no revertir sin pensarlo

- **Ante la duda al agrupar, el coste corre en ambas direcciones.** Un grupo falso genera una alerta falsa y enseña al equipo a ignorarte. Pero partir un problema real en cinco grupos lo *esconde*: cada fragmento cae bajo el umbral y un incidente genuino se reporta como cinco quejas sueltas.
- **La prioridad individual tope es `alta`.** No existe nivel crítico. El estatus de incidente sale del cómputo, nunca del juicio del modelo sobre una mención.
- **Una fuente ilegible no aporta una suposición.** Si un enlace no se puede recuperar, el agente lo dice y pide el texto. No describe páginas que no leyó.
- **Un grupo sin fecha falla la condición de recencia**, no la aprueba. Desconocido no es reciente.
- **Escalar es siempre una propuesta con clic.** El destino (Jira, Azure DevOps, Trello) se configura por MCP según el equipo. En esta demo el clic registra la decisión y no crea nada en ningún sistema.

---

## Ejecutar en local

Requiere **Node.js 22+**.

```bash
git clone https://github.com/Eliza-05/ECIMIND-TEAM.git
cd ECIMIND-TEAM
npm ci
cp .env.example .env
```

### Variables de entorno

Todas van en **un solo `.env` en la raíz** (el runtime lo lee con `--env-file=../../.env`).

```dotenv
# Modelo — vía OpenRouter
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=          # https://openrouter.ai/keys
MODEL=google/gemini-3.8-flash # slug publisher/modelo, debe soportar tool calling

# Slack gestionado por CopilotKit Intelligence
INTELLIGENCE_API_KEY=        # formato cpk-{projectId}_...
CHANNEL_CODE=                # el Channel Code EXACTO de Intelligence

# Exa — búsqueda y lectura de enlaces
EXA_API_KEY=                 # https://dashboard.exa.ai/api-keys
EXA_SEARCH_TYPE=fast         # `fast` o `instant`; nada más lento

LOG_LEVEL=debug
PORT=3000
```

Detalles que muerden:

- **`MODEL` sin `/` recibe el prefijo `openai/` automáticamente.** Escribe siempre el slug completo.
- **El CLI de CopilotKit escribe `CPK_INTELLIGENCE_API_KEY`, pero el código lee `INTELLIGENCE_API_KEY`.** Mismo valor, dos nombres. Si vuelves a correr `project select`, solo se actualiza el primero y hay que sincronizar el segundo a mano.
- `EXA_SEARCH_TYPE` se lee **una vez al cargar el módulo**. Cambiarla exige reiniciar el proceso.
- Sin `EXA_API_KEY` el agente arranca igual, pero solo analiza texto pegado en el canal — y lo dice explícitamente en el hilo.

### Conectar Slack

Si el Channel ya existe, basta con poner `CHANNEL_CODE` e `INTELLIGENCE_API_KEY`. Desde cero:

```bash
npx copilotkit@latest login          # abre navegador
npx copilotkit@latest project select --project <slug>
npx copilotkit@latest channels add --name <code> --adapter slack --json
```

El último comando emite un enlace con un manifiesto prellenado para crear la app de Slack. Te pedirá dos credenciales de esa app (**Bot User OAuth Token** y **Signing Secret**) en variables cuyo nombre exacto te indica; una vez adjuntas, Intelligence las guarda de su lado y **puedes borrarlas del `.env`**.

Guía completa: <https://copilotkit.ai/channels-guide.md>

### Arrancar

```bash
npm run dev:slack
```

Éxito es:

```
✓ Channel "<code>" online — listening on :3000
```

Si lo ves, la conexión es real: el arranque mata el proceso si el Channel no está `online`. Que el proceso viva no basta como prueba — `ready()` también resuelve en `setup_required`.

Después, invita al bot a un canal. Instalado pero sin invitar a ninguna conversación, no responde nada y parece roto:

```
/invite @monitordereputacion2
```

> El handle de Slack no lleva guiones aunque el nombre visible sí. Si el autocompletado no encuentra nada, usa el ID: `/invite <@U0C0ZBDTUR5>`.

### Comprobaciones

```bash
npm run verify          # typecheck de los 3 workspaces + 144 tests offline
npm run channel:status  # estado del Channel en Intelligence
```

`npm run verify` no valida acceso real a cuentas: cubre comportamiento offline. Las pruebas en vivo de Slack, Exa y modelo se documentan aparte.

---

## Estructura

Lo propio de este proyecto:

```
packages/agent-core/src/
  prompt.ts              REPUTATION_ROLE (el rol del agente)
  classify.ts            clasificación por mención, JSON estricto
  cluster.ts             agrupamiento; lo contable se calcula aquí, no en el modelo
  incident.ts            la regla de incidente — código puro, sin modelo
  incident-config.ts     los tres umbrales, solos, para poder discutirlos
  llm.ts                 llamada directa al modelo + reintento ante rate limit
  prompts/classify.ts    \ los prompts, fuera de la lógica, para ajustarlos rápido
  prompts/cluster.ts     /
  capabilities/search.ts  las 6 consultas y el barrido en Exa
  capabilities/ingest.ts  enlaces y texto pegados en el canal

apps/channel/src/
  channel.tsx            tools, componentes y contexto del Channel
  analyze.ts             analyze_reputation: encadena el pipeline completo
  tools.tsx              read_thread, propose_escalation
  components.tsx         mention_group_card, reputation_summary
```

Heredado del starter kit y sin tocar: `server.ts`, `agent.ts`, `env.ts`, `model.ts`, el harness de tests del gateway gestionado.

### Ajustes frecuentes

| quiero… | archivo |
|---|---|
| cambiar cuándo algo es incidente | `incident-config.ts` |
| que agrupe más o menos | `prompts/cluster.ts` |
| cambiar dónde busca | `capabilities/search.ts` |
| cambiar el tono o las reglas del agente | `prompt.ts` |

---

## Limitaciones conocidas

Documentadas porque son reales, no por exhaustividad.

**`read_thread` no lee Slack.** Lee el transcript que CopilotKit Intelligence grabó de esa conversación. Los mensajes publicados mientras el bot no participaba **no existen para él**, ni siquiera en el mismo hilo. Por eso hay que mencionarlo antes de pegar las quejas. En la ruta gestionada el SDK no ofrece ninguna forma de leer el historial del canal; haría falta llamar a la API de Slack directamente.

**El puente entre `read_thread` y `analyze_reputation` depende del modelo.** Las menciones del canal llegan al análisis como un parámetro que el modelo debe rellenar copiando lo que acaba de leer. Si no lo hace, el análisis corre sin esa mitad de la evidencia y nada lo detecta.

**`es_queja` se calcula y no se usa.** Menciones que no son quejas —artículos de reseña, posts no relacionados— entran al agrupamiento igual.

**Límites de tasa.** Una cuenta nueva de OpenRouter permite 20 peticiones por minuto. El pipeline clasifica cada mención por separado, así que corre con un pool de 3 y reintenta con backoff, y `resultsPerQuery` está en 2. Con una cuenta con saldo, sube ambos y recuperas calidad de análisis.

**La diversidad de fuentes trajo ruido.** Anclar consultas a sitios de reseñas y comunidades generales subió de 1 a 9 dominios distintos, pero también mete artículos de reseña y resultados no relacionados que antes no aparecían.

---

## Créditos

Infraestructura heredada del [starter kit](https://github.com/CopilotKit/agents-everywhere-starter-kit): CopilotKit Channels, el adaptador de modelo y el harness de tests.

Construido durante el hackathon **Agents, Everywhere** (AI Tinkerers, septiembre 2026): el pipeline de reputación completo —consultas multiidioma, clasificación, agrupamiento translingüe, regla de incidente, ingesta desde el canal— más los componentes y tools de Slack.

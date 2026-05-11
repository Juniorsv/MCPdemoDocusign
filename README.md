# DocuSign MCP Server — Demo Interactiva

Demo web interactiva que muestra cómo un agente de IA interactúa con DocuSign a través del protocolo MCP (Model Context Protocol).

## Qué hace

Un chat en tiempo real donde el usuario escribe en lenguaje natural y el agente de IA (Claude) ejecuta acciones en DocuSign:

- 🔍 **Buscar acuerdos** — Consulta contratos por empresa, estado o tipo
- ✉️ **Enviar a firma** — Crea envelopes desde templates
- ⚡ **Disparar workflows** — Ejecuta flujos de Maestro en bulk
- 🧠 **Analizar contratos** — Extrae cláusulas y evalúa riesgos con IA
- 📋 **Gestionar firmas** — Envía recordatorios a firmantes pendientes

## Dos modos de operación

| Modo | Qué hace | Requiere |
|------|----------|----------|
| **Demo** | Claude usa herramientas simuladas con datos realistas de LATAM | Solo API key de Anthropic |
| **En vivo** | Claude se conecta al MCP Server real de DocuSign | API key + DocuSign MCP beta |

## Setup rápido (5 minutos)

### 1. Crear repo en GitHub

Crea un repositorio nuevo en GitHub y sube todos estos archivos.

### 2. Obtener API key de Anthropic

1. Ve a [console.anthropic.com](https://console.anthropic.com/)
2. Crea una cuenta o inicia sesión
3. Ve a **API Keys** → **Create Key**
4. Copia la key (empieza con `sk-ant-`)

### 3. Deploy en Render

1. Ve a [render.com](https://render.com) → **New** → **Web Service**
2. Conecta tu repo de GitHub
3. Render detectará el `render.yaml` automáticamente
4. En **Environment Variables**, agrega:
   - `ANTHROPIC_API_KEY` = tu key de Anthropic
5. Click **Deploy**

¡Listo! Tu demo estará en `https://tu-app.onrender.com`

### Desarrollo local (opcional)

```bash
git clone https://github.com/tu-usuario/docusign-mcp-demo.git
cd docusign-mcp-demo
npm install
cp .env.example .env
# Edita .env con tu ANTHROPIC_API_KEY
npm start
# Abre http://localhost:3000
```

## Estructura del proyecto

```
├── server.js          → Backend Express + Claude API + tool execution
├── public/
│   └── index.html     → Frontend completo (chat, tools, arquitectura)
├── package.json       → Dependencias
├── render.yaml        → Config de deploy para Render
├── .env.example       → Template de variables de entorno
└── README.md          → Este archivo
```

## Cómo funciona

```
Usuario escribe: "Muéstrame contratos pendientes con Banco Nacional"
        │
        ▼
  [Frontend] → POST /api/chat
        │
        ▼
  [Backend] → Claude API con tools de DocuSign definidas
        │
        ▼
  [Claude] → Decide invocar search_agreements(query="Banco Nacional", status="pending")
        │
        ▼
  [Backend] → Ejecuta tool (mock en demo, real en vivo) → devuelve resultado a Claude
        │
        ▼
  [Claude] → Interpreta resultados → genera respuesta en español
        │
        ▼
  [Frontend] → Muestra: MCP Tool Call → Resultado → Respuesta del agente
```

## Datos de demo incluidos

El modo demo incluye datos realistas de clientes LATAM:

- **Banco Nacional** — 3 contratos pendientes
- **SQM Industrial** — Contrato de arrendamiento con análisis de cláusulas
- **Credicorp** — Contrato de servicios completado
- **INS Valores** — Póliza de seguro colectivo
- **BAC Costa Rica** — Acuerdo de distribución

5 templates pre-configurados (servicios, NDA, onboarding, arrendamiento, addendum).

## Para activar modo "En vivo"

1. Solicita acceso al programa beta de DocuSign MCP
2. Configura `DOCUSIGN_MCP_URL` en Render
3. En la demo, cambia el toggle a "En vivo"
4. Claude se conectará directamente al MCP Server de DocuSign

## Licencia

Proyecto de demo para uso interno de preventa.

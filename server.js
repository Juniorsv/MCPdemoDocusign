require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DOCUSIGN_MCP_URL = process.env.DOCUSIGN_MCP_URL || "https://mcp-d.docusign.com/mcp";

// ─── In-memory conversation store (per session) ─────────────────────────
const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, { messages: [] });
  }
  return sessions.get(id);
}

// ─── DocuSign mock data for demo mode ────────────────────────────────────
const MOCK_DATA = {
  agreements: [
    { id: "agr-10421", name: "Contrato Marco de Servicios — Banco Nacional", status: "pending", signers_completed: 3, signers_total: 5, created: "2026-04-28", type: "service_agreement" },
    { id: "agr-10422", name: "NDA Confidencialidad — Banco Nacional", status: "pending", signers_completed: 1, signers_total: 2, created: "2026-05-01", type: "nda" },
    { id: "agr-10423", name: "Addendum Precios Q2 — Banco Nacional", status: "pending", signers_completed: 0, signers_total: 3, created: "2026-05-03", type: "addendum" },
    { id: "agr-10430", name: "Contrato Arrendamiento Planta — SQM Industrial", status: "active", signers_completed: 4, signers_total: 4, created: "2025-10-15", type: "lease", pages: 42 },
    { id: "agr-10440", name: "Contrato de Servicios LATAM — Credicorp", status: "completed", signers_completed: 3, signers_total: 3, created: "2026-03-20", type: "service_agreement" },
    { id: "agr-10450", name: "Póliza de Seguro Colectivo — INS Valores", status: "pending", signers_completed: 2, signers_total: 4, created: "2026-05-05", type: "insurance" },
    { id: "agr-10460", name: "Acuerdo de Distribución — BAC Costa Rica", status: "active", signers_completed: 2, signers_total: 2, created: "2026-01-12", type: "distribution" },
  ],
  templates: [
    { id: "tmpl-4829", name: "Contrato de Servicios LATAM v3.2", last_used: "2026-04-15", category: "servicios" },
    { id: "tmpl-4830", name: "NDA Bilateral Estándar", last_used: "2026-05-02", category: "confidencialidad" },
    { id: "tmpl-4831", name: "Onboarding Proveedores Pack", last_used: "2026-04-20", category: "proveedores" },
    { id: "tmpl-4832", name: "Contrato de Arrendamiento Comercial", last_used: "2026-03-10", category: "inmobiliario" },
    { id: "tmpl-4833", name: "Addendum de Precios Trimestral", last_used: "2026-04-01", category: "comercial" },
  ],
  clauses: {
    "agr-10430": [
      { clause: "Cláusula 14.2 — Renovación automática", risk: "medium", detail: "Renovación automática por períodos de 12 meses si no hay aviso con 90 días de anticipación. Fecha límite para aviso de no-renovación: 15 de julio de 2026." },
      { clause: "Cláusula 14.5 — Terminación anticipada", risk: "high", detail: "Penalidad del 30% del valor restante del contrato en caso de terminación anticipada unilateral." },
      { clause: "Cláusula 8.3 — Ajuste de canon", risk: "low", detail: "Ajuste anual del canon de arrendamiento según IPC + 2 puntos porcentuales." },
    ],
  },
};

// ─── Tool definitions (used in both demo + live mode) ────────────────────
const DOCUSIGN_TOOLS = [
  {
    name: "search_agreements",
    description: "Busca acuerdos/contratos en DocuSign Navigator por nombre, estado, tipo o empresa. Retorna una lista de acuerdos que coinciden con los criterios.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto de búsqueda: nombre de empresa, tipo de contrato, palabras clave" },
        status: { type: "string", enum: ["pending", "active", "completed", "all"], description: "Filtro de estado del acuerdo" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_agreement_details",
    description: "Obtiene los detalles completos de un acuerdo específico por su ID, incluyendo firmantes, fechas y metadata.",
    input_schema: {
      type: "object",
      properties: {
        agreement_id: { type: "string", description: "ID del acuerdo (ej: agr-10421)" },
      },
      required: ["agreement_id"],
    },
  },
  {
    name: "analyze_agreement",
    description: "Analiza un acuerdo con IA para extraer cláusulas clave, identificar riesgos y generar insights. Útil para revisión de contratos.",
    input_schema: {
      type: "object",
      properties: {
        agreement_id: { type: "string", description: "ID del acuerdo a analizar" },
        analysis_type: {
          type: "array",
          items: { type: "string", enum: ["renewal_clauses", "auto_renewal", "termination", "penalties", "obligations", "dates"] },
          description: "Tipos de análisis a realizar",
        },
      },
      required: ["agreement_id"],
    },
  },
  {
    name: "list_templates",
    description: "Lista las plantillas disponibles en la cuenta de DocuSign, con opción de filtrar por nombre o categoría.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Filtro de búsqueda para nombre o categoría de template" },
      },
    },
  },
  {
    name: "create_envelope",
    description: "Crea y envía un nuevo sobre (envelope) de DocuSign a partir de un template, con los destinatarios especificados.",
    input_schema: {
      type: "object",
      properties: {
        template_id: { type: "string", description: "ID del template a usar" },
        recipients: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
              role: { type: "string", enum: ["signer", "cc", "approver"] },
            },
          },
          description: "Lista de destinatarios",
        },
        email_subject: { type: "string", description: "Asunto del email de firma" },
      },
      required: ["template_id", "recipients"],
    },
  },
  {
    name: "trigger_maestro_workflow",
    description: "Dispara un workflow de DocuSign Maestro. Puede ser individual o en bulk desde un archivo.",
    input_schema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "ID del workflow de Maestro" },
        trigger_type: { type: "string", enum: ["single", "bulk"], description: "Tipo de ejecución" },
        parameters: { type: "object", description: "Parámetros del workflow" },
      },
      required: ["workflow_id"],
    },
  },
  {
    name: "send_reminder",
    description: "Envía un recordatorio de firma a los firmantes pendientes de un envelope.",
    input_schema: {
      type: "object",
      properties: {
        agreement_id: { type: "string", description: "ID del acuerdo" },
        message: { type: "string", description: "Mensaje personalizado del recordatorio" },
      },
      required: ["agreement_id"],
    },
  },
];

// ─── Mock tool executor (demo mode) ─────────────────────────────────────
function executeMockTool(name, input) {
  switch (name) {
    case "search_agreements": {
      const q = (input.query || "").toLowerCase();
      const status = input.status || "all";
      let results = MOCK_DATA.agreements.filter((a) => {
        const matchesQuery = a.name.toLowerCase().includes(q) || a.type.includes(q);
        const matchesStatus = status === "all" || a.status === status;
        return matchesQuery && matchesStatus;
      });
      if (results.length === 0) {
        results = MOCK_DATA.agreements.filter((a) => status === "all" || a.status === status).slice(0, 3);
      }
      return { total: results.length, agreements: results };
    }
    case "get_agreement_details": {
      const agr = MOCK_DATA.agreements.find((a) => a.id === input.agreement_id);
      return agr || { error: "Acuerdo no encontrado" };
    }
    case "analyze_agreement": {
      const clauses = MOCK_DATA.clauses[input.agreement_id];
      if (clauses) {
        return { agreement_id: input.agreement_id, analysis: clauses, analyzed_at: new Date().toISOString() };
      }
      return {
        agreement_id: input.agreement_id,
        analysis: [
          { clause: "Cláusula de vigencia", risk: "low", detail: "Contrato vigente por 24 meses desde la fecha de firma." },
          { clause: "Cláusula de confidencialidad", risk: "low", detail: "Obligación de confidencialidad por 5 años post-terminación." },
        ],
        analyzed_at: new Date().toISOString(),
      };
    }
    case "list_templates": {
      const search = (input.search || "").toLowerCase();
      const results = search
        ? MOCK_DATA.templates.filter((t) => t.name.toLowerCase().includes(search) || t.category.includes(search))
        : MOCK_DATA.templates;
      return { total: results.length, templates: results };
    }
    case "create_envelope": {
      const envId = "env-" + Math.floor(10000 + Math.random() * 90000);
      return {
        envelope_id: envId,
        status: "sent",
        template_used: input.template_id,
        recipients_count: input.recipients?.length || 0,
        sent_at: new Date().toISOString(),
        message: "Sobre creado y enviado exitosamente.",
      };
    }
    case "trigger_maestro_workflow": {
      const runId = "wf-run-" + Math.floor(10000 + Math.random() * 90000);
      const isBulk = input.trigger_type === "bulk";
      const count = input.parameters?.count || (isBulk ? 15 : 1);
      return {
        workflow_run_id: runId,
        workflow_id: input.workflow_id,
        status: "running",
        instances_created: count,
        estimated_completion: isBulk ? "~12 minutos" : "~2 minutos",
        triggered_at: new Date().toISOString(),
      };
    }
    case "send_reminder": {
      return {
        success: true,
        agreement_id: input.agreement_id,
        reminders_sent: 2,
        message: "Recordatorios enviados a los firmantes pendientes.",
      };
    }
    default:
      return { error: "Tool no reconocida: " + name };
  }
}

// ─── System prompt ──────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres un agente de IA especializado en gestión de acuerdos corporativos, conectado a DocuSign a través del protocolo MCP (Model Context Protocol).

Tu rol es ayudar a usuarios de empresas en Latinoamérica a gestionar sus contratos, acuerdos y flujos de firma de manera conversacional.

REGLAS:
- Responde siempre en español
- Sé conciso pero informativo
- Cuando el usuario pregunte sobre contratos o acuerdos, USA las herramientas disponibles para buscar información real
- Después de usar una herramienta, interpreta los resultados de forma clara y accionable
- Sugiere siempre un siguiente paso (enviar recordatorio, crear sobre, analizar cláusulas, etc.)
- Si el usuario pide enviar algo, confirma los detalles antes de ejecutar
- Formatea las listas con bullets para claridad
- Menciona IDs de documentos y envelopes cuando sea relevante
- Cuando hables de riesgos en cláusulas, usa los niveles: bajo, medio, alto

CONTEXTO: Estás conectado al DocuSign MCP Server que te da acceso a:
- Navigator: Búsqueda y análisis inteligente de acuerdos
- eSignature: Gestión de sobres, templates y firmas
- Maestro: Automatización de workflows

Los clientes con los que trabajas incluyen empresas bancarias, de seguros y de industria en Colombia, Costa Rica, Chile, México y República Dominicana.`;

// ─── Chat endpoint ──────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, sessionId, mode } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const session = getSession(sessionId || "default");
  session.messages.push({ role: "user", content: message });

  // Keep conversation manageable (last 20 messages)
  if (session.messages.length > 20) {
    session.messages = session.messages.slice(-20);
  }

  try {
    const isLiveMode = mode === "live";
    let responseBlocks = [];
    let toolTrace = []; // Track MCP tool calls for the frontend

    if (isLiveMode) {
      // ── LIVE MODE: Claude API with real MCP server ──
      const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-3-5-haiku-20241022",
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: session.messages,
          mcp_servers: [
            {
              type: "url",
              url: DOCUSIGN_MCP_URL,
              name: "docusign",
            },
          ],
        }),
      });

      if (!apiRes.ok) {
        const errText = await apiRes.text();
        throw new Error(`Claude API error ${apiRes.status}: ${errText}`);
      }

      const data = await apiRes.json();

      // Parse all content blocks
      for (const block of data.content || []) {
        if (block.type === "text") {
          responseBlocks.push({ type: "text", text: block.text });
        } else if (block.type === "mcp_tool_use") {
          toolTrace.push({ tool: block.name, input: block.input });
        } else if (block.type === "mcp_tool_result") {
          const resultText = block.content?.[0]?.text || JSON.stringify(block.content);
          toolTrace.push({ result: resultText });
        }
      }
    } else {
      // ── DEMO MODE: Claude API with local tool simulation ──
      let currentMessages = [...session.messages];
      let iterations = 0;
      const MAX_ITERATIONS = 5;

      while (iterations < MAX_ITERATIONS) {
        iterations++;

        const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-3-5-haiku-20241022",
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages: currentMessages,
            tools: DOCUSIGN_TOOLS,
          }),
        });

        if (!apiRes.ok) {
          const errText = await apiRes.text();
          throw new Error(`Claude API error ${apiRes.status}: ${errText}`);
        }

        const data = await apiRes.json();

        // Collect text blocks
        const textBlocks = data.content.filter((b) => b.type === "text");
        const toolUseBlocks = data.content.filter((b) => b.type === "tool_use");

        for (const tb of textBlocks) {
          if (tb.text.trim()) responseBlocks.push({ type: "text", text: tb.text });
        }

        if (toolUseBlocks.length === 0 || data.stop_reason === "end_turn") {
          break;
        }

        // Process tool calls
        const toolResults = [];
        for (const toolCall of toolUseBlocks) {
          const mockResult = executeMockTool(toolCall.name, toolCall.input);

          toolTrace.push({
            tool: toolCall.name,
            input: toolCall.input,
            result: mockResult,
          });

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolCall.id,
            content: JSON.stringify(mockResult),
          });
        }

        // Add assistant response + tool results for next iteration
        currentMessages.push({ role: "assistant", content: data.content });
        currentMessages.push({ role: "user", content: toolResults });
      }
    }

    // Build final text
    const assistantText = responseBlocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");

    // Save to session
    if (assistantText) {
      session.messages.push({ role: "assistant", content: assistantText });
    }

    res.json({
      text: assistantText,
      tools: toolTrace,
      mode: isLiveMode ? "live" : "demo",
    });
  } catch (error) {
    console.error("Chat error:", error.message);
    res.status(500).json({
      error: "Error al procesar el mensaje",
      detail: error.message,
    });
  }
});

// ─── Reset session ──────────────────────────────────────────────────────
app.post("/api/reset", (req, res) => {
  const { sessionId } = req.body;
  sessions.delete(sessionId || "default");
  res.json({ ok: true });
});

// ─── Health check ───────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    hasApiKey: !!ANTHROPIC_API_KEY,
    mcpUrl: DOCUSIGN_MCP_URL,
  });
});

// ─── Catch-all: serve frontend ──────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n  🚀 DocuSign MCP Demo running on http://localhost:${PORT}`);
  console.log(`  📡 MCP Server: ${DOCUSIGN_MCP_URL}`);
  console.log(`  🔑 API Key: ${ANTHROPIC_API_KEY ? "configured" : "⚠️  MISSING"}\n`);
});

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── DocuSign Config ────────────────────────────────────────────────────
const DS_CONFIG = {
  integrationKey: process.env.DOCUSIGN_INTEGRATION_KEY,
  userId: process.env.DOCUSIGN_USER_ID,
  accountId: process.env.DOCUSIGN_ACCOUNT_ID,
  rsaPrivateKey: process.env.DOCUSIGN_RSA_PRIVATE_KEY
    ? Buffer.from(process.env.DOCUSIGN_RSA_PRIVATE_KEY, "base64").toString("utf-8")
    : null,
  basePath: "https://demo.docusign.net/restapi",
  oauthBasePath: "https://account-d.docusign.com",
};

const hasDocuSignConfig =
  DS_CONFIG.integrationKey && DS_CONFIG.userId && DS_CONFIG.accountId && DS_CONFIG.rsaPrivateKey;

// ─── DocuSign JWT Auth ──────────────────────────────────────────────────
let dsAccessToken = null;
let dsTokenExpiry = 0;

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getDocuSignToken() {
  const now = Math.floor(Date.now() / 1000);
  if (dsAccessToken && now < dsTokenExpiry - 300) return dsAccessToken;

  const header = { typ: "JWT", alg: "RS256" };
  const payload = {
    iss: DS_CONFIG.integrationKey,
    sub: DS_CONFIG.userId,
    aud: "account-d.docusign.com",
    iat: now,
    exp: now + 3600,
    scope: "signature impersonation",
  };

  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const sigInput = headerB64 + "." + payloadB64;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(sigInput);
  const signature = base64url(sign.sign(DS_CONFIG.rsaPrivateKey));

  const jwt = sigInput + "." + signature;

  const res = await fetch(DS_CONFIG.oauthBasePath + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + jwt,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error("DocuSign OAuth error: " + res.status + " - " + err);
  }

  const data = await res.json();
  dsAccessToken = data.access_token;
  dsTokenExpiry = now + data.expires_in;
  return dsAccessToken;
}

// ─── DocuSign API Helper ────────────────────────────────────────────────
async function dsApi(method, endpoint, body) {
  const token = await getDocuSignToken();
  const url = DS_CONFIG.basePath + "/v2.1/accounts/" + DS_CONFIG.accountId + endpoint;

  const opts = {
    method: method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  };

  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error("DocuSign API " + res.status + ": " + err);
  }
  return res.json();
}

// ─── In-memory conversation store ───────────────────────────────────────
const sessions = new Map();
function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { messages: [] });
  return sessions.get(id);
}

// ─── Mock data (fallback) ───────────────────────────────────────────────
const MOCK_DATA = {
  agreements: [
    { id: "agr-10421", name: "Contrato Marco de Servicios — Banco Nacional", status: "pending", signers_completed: 3, signers_total: 5, created: "2026-04-28" },
    { id: "agr-10422", name: "NDA Confidencialidad — Banco Nacional", status: "pending", signers_completed: 1, signers_total: 2, created: "2026-05-01" },
    { id: "agr-10423", name: "Addendum Precios Q2 — Banco Nacional", status: "pending", signers_completed: 0, signers_total: 3, created: "2026-05-03" },
    { id: "agr-10430", name: "Contrato Arrendamiento Planta — SQM Industrial", status: "active", signers_completed: 4, signers_total: 4, created: "2025-10-15", pages: 42 },
    { id: "agr-10440", name: "Contrato de Servicios LATAM — Credicorp", status: "completed", signers_completed: 3, signers_total: 3, created: "2026-03-20" },
  ],
  templates: [
    { id: "tmpl-4829", name: "Contrato de Servicios LATAM v3.2", last_used: "2026-04-15", category: "servicios" },
    { id: "tmpl-4830", name: "NDA Bilateral Estándar", last_used: "2026-05-02", category: "confidencialidad" },
    { id: "tmpl-4831", name: "Onboarding Proveedores Pack", last_used: "2026-04-20", category: "proveedores" },
  ],
};

// ─── Tool definitions ───────────────────────────────────────────────────
const DOCUSIGN_TOOLS = [
  {
    name: "search_envelopes",
    description: "Busca sobres/envelopes en DocuSign por texto, estado o fecha. Usa esto cuando el usuario pregunte por contratos, acuerdos o documentos.",
    input_schema: {
      type: "object",
      properties: {
        search_text: { type: "string", description: "Texto de búsqueda" },
        status: { type: "string", enum: ["sent", "delivered", "completed", "declined", "voided", "created"], description: "Filtro de estado" },
        from_date: { type: "string", description: "Fecha desde (ISO 8601). Default: últimos 30 días." },
      },
    },
  },
  {
    name: "get_envelope",
    description: "Obtiene detalles completos de un envelope por su ID.",
    input_schema: {
      type: "object",
      properties: { envelope_id: { type: "string", description: "ID del envelope" } },
      required: ["envelope_id"],
    },
  },
  {
    name: "get_envelope_recipients",
    description: "Obtiene firmantes y destinatarios de un envelope con su estado.",
    input_schema: {
      type: "object",
      properties: { envelope_id: { type: "string", description: "ID del envelope" } },
      required: ["envelope_id"],
    },
  },
  {
    name: "list_templates",
    description: "Lista templates disponibles en la cuenta DocuSign.",
    input_schema: {
      type: "object",
      properties: { search_text: { type: "string", description: "Filtro por nombre" } },
    },
  },
  {
    name: "create_envelope_from_template",
    description: "Crea y envía un envelope desde un template. Requiere template_id y firmantes.",
    input_schema: {
      type: "object",
      properties: {
        template_id: { type: "string", description: "ID del template" },
        email_subject: { type: "string", description: "Asunto del email" },
        signers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
              role_name: { type: "string", description: "Rol en el template (ej: Signer 1)" },
            },
            required: ["name", "email", "role_name"],
          },
        },
        status: { type: "string", enum: ["sent", "created"], description: "sent=enviar, created=borrador" },
      },
      required: ["template_id", "signers"],
    },
  },
  {
    name: "send_reminder",
    description: "Envía recordatorio de firma a firmantes pendientes.",
    input_schema: {
      type: "object",
      properties: { envelope_id: { type: "string" } },
      required: ["envelope_id"],
    },
  },
  {
    name: "void_envelope",
    description: "Anula un envelope que no ha sido completado.",
    input_schema: {
      type: "object",
      properties: {
        envelope_id: { type: "string" },
        void_reason: { type: "string", description: "Razón de anulación" },
      },
      required: ["envelope_id", "void_reason"],
    },
  },
];

// ─── REAL DocuSign Tool Executor ────────────────────────────────────────
async function executeRealTool(name, input) {
  switch (name) {
    case "search_envelopes": {
      var params = new URLSearchParams();
      if (input.search_text) params.set("search_text", input.search_text);
      if (input.status) params.set("status", input.status);
      if (input.from_date) {
        params.set("from_date", input.from_date);
      } else {
        var d = new Date();
        d.setDate(d.getDate() - 30);
        params.set("from_date", d.toISOString());
      }
      params.set("count", "20");
      params.set("order_by", "last_modified");
      params.set("order", "desc");
      var data = await dsApi("GET", "/envelopes?" + params.toString());
      return {
        total: data.totalSetSize || 0,
        envelopes: (data.envelopes || []).map(function (e) {
          return {
            envelope_id: e.envelopeId,
            subject: e.emailSubject || "(sin asunto)",
            status: e.status,
            created: e.createdDateTime,
            sender: e.sender ? e.sender.userName : "N/A",
          };
        }),
      };
    }
    case "get_envelope": {
      var data = await dsApi("GET", "/envelopes/" + input.envelope_id);
      return {
        envelope_id: data.envelopeId,
        subject: data.emailSubject,
        status: data.status,
        created: data.createdDateTime,
        sent: data.sentDateTime,
        completed: data.completedDateTime,
        sender: data.sender ? data.sender.userName : "N/A",
      };
    }
    case "get_envelope_recipients": {
      var data = await dsApi("GET", "/envelopes/" + input.envelope_id + "/recipients");
      return {
        signers: (data.signers || []).map(function (s) {
          return { name: s.name, email: s.email, status: s.status, signed_at: s.signedDateTime, role: s.roleName };
        }),
        carbon_copies: (data.carbonCopies || []).map(function (c) {
          return { name: c.name, email: c.email, status: c.status };
        }),
      };
    }
    case "list_templates": {
      var params = new URLSearchParams();
      if (input.search_text) params.set("search_text", input.search_text);
      params.set("count", "20");
      var data = await dsApi("GET", "/templates?" + params.toString());
      return {
        total: (data.envelopeTemplates || []).length,
        templates: (data.envelopeTemplates || []).map(function (t) {
          return { template_id: t.templateId, name: t.name, description: t.description || "", last_modified: t.lastModified };
        }),
      };
    }
    case "create_envelope_from_template": {
      var body = {
        templateId: input.template_id,
        templateRoles: input.signers.map(function (s) {
          return { name: s.name, email: s.email, roleName: s.role_name };
        }),
        status: input.status || "sent",
      };
      if (input.email_subject) body.emailSubject = input.email_subject;
      var data = await dsApi("POST", "/envelopes", body);
      return {
        envelope_id: data.envelopeId,
        status: data.status,
        message: "Envelope " + (data.status === "sent" ? "creado y enviado" : "creado como borrador") + " exitosamente.",
      };
    }
    case "send_reminder": {
      await dsApi("PUT", "/envelopes/" + input.envelope_id, { resend_envelope: "true" });
      return { success: true, envelope_id: input.envelope_id, message: "Recordatorio enviado." };
    }
    case "void_envelope": {
      await dsApi("PUT", "/envelopes/" + input.envelope_id, { status: "voided", voidedReason: input.void_reason });
      return { success: true, envelope_id: input.envelope_id, message: "Envelope anulado." };
    }
    default:
      return { error: "Tool no reconocida: " + name };
  }
}

// ─── Mock Tool Executor ─────────────────────────────────────────────────
function executeMockTool(name, input) {
  switch (name) {
    case "search_envelopes": {
      var q = (input.search_text || "").toLowerCase();
      var results = MOCK_DATA.agreements.filter(function (a) { return a.name.toLowerCase().includes(q); });
      if (results.length === 0) results = MOCK_DATA.agreements.slice(0, 3);
      return {
        total: results.length,
        envelopes: results.map(function (a) {
          return { envelope_id: a.id, subject: a.name, status: a.status, created: a.created, signers_progress: a.signers_completed + "/" + a.signers_total };
        }),
      };
    }
    case "get_envelope": {
      var agr = MOCK_DATA.agreements.find(function (a) { return a.id === input.envelope_id; });
      if (!agr) return { error: "No encontrado" };
      return { envelope_id: agr.id, subject: agr.name, status: agr.status, created: agr.created };
    }
    case "get_envelope_recipients": {
      return {
        signers: [
          { name: "María López", email: "mlopez@example.com", status: "completed", role: "Firmante 1" },
          { name: "Carlos Ruiz", email: "cruiz@example.com", status: "sent", role: "Firmante 2" },
        ],
      };
    }
    case "list_templates": {
      var search = (input.search_text || "").toLowerCase();
      var results = search ? MOCK_DATA.templates.filter(function (t) { return t.name.toLowerCase().includes(search); }) : MOCK_DATA.templates;
      return { total: results.length, templates: results.map(function (t) { return { template_id: t.id, name: t.name, last_modified: t.last_used }; }) };
    }
    case "create_envelope_from_template": {
      return { envelope_id: "env-" + Math.floor(10000 + Math.random() * 90000), status: input.status || "sent", message: "Envelope enviado exitosamente (demo)." };
    }
    case "send_reminder": {
      return { success: true, message: "Recordatorio enviado (demo)." };
    }
    case "void_envelope": {
      return { success: true, message: "Envelope anulado (demo)." };
    }
    default:
      return { error: "Tool no reconocida" };
  }
}

// ─── System prompt ──────────────────────────────────────────────────────
var SYSTEM_PROMPT = "Eres un agente de IA especializado en gestión de acuerdos corporativos, conectado a DocuSign a través del protocolo MCP.\n\n"
  + "Tu rol es ayudar a usuarios en Latinoamérica a gestionar contratos y flujos de firma de manera conversacional.\n\n"
  + "REGLAS:\n"
  + "- Responde siempre en español\n"
  + "- Sé conciso pero informativo\n"
  + "- Cuando pregunten por contratos o documentos, USA las herramientas disponibles\n"
  + "- Interpreta resultados de forma clara y accionable\n"
  + "- Sugiere siempre un siguiente paso\n"
  + "- Si piden enviar algo, confirma detalles antes de ejecutar\n"
  + "- Menciona IDs de envelopes cuando sea relevante\n"
  + (hasDocuSignConfig
    ? "- Estás conectado a una cuenta REAL de DocuSign sandbox. Las acciones son reales.\n"
    : "- Estás en modo DEMO con datos simulados.\n");

// ─── Chat endpoint ──────────────────────────────────────────────────────
app.post("/api/chat", async function (req, res) {
  var message = req.body.message;
  var sessionId = req.body.sessionId;
  var mode = req.body.mode;

  if (!message) return res.status(400).json({ error: "Message is required" });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  var session = getSession(sessionId || "default");
  session.messages.push({ role: "user", content: message });
  if (session.messages.length > 20) session.messages = session.messages.slice(-20);

  var useRealDocuSign = mode === "live" && hasDocuSignConfig;

  try {
    var responseBlocks = [];
    var toolTrace = [];
    var currentMessages = session.messages.slice();
    var iterations = 0;

    while (iterations < 5) {
      iterations++;

      var apiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: currentMessages,
          tools: DOCUSIGN_TOOLS,
        }),
      });

      if (!apiRes.ok) {
        var errText = await apiRes.text();
        throw new Error("Claude API error " + apiRes.status + ": " + errText);
      }

      var data = await apiRes.json();
      var textBlocks = data.content.filter(function (b) { return b.type === "text"; });
      var toolUseBlocks = data.content.filter(function (b) { return b.type === "tool_use"; });

      for (var i = 0; i < textBlocks.length; i++) {
        if (textBlocks[i].text.trim()) responseBlocks.push({ type: "text", text: textBlocks[i].text });
      }

      if (toolUseBlocks.length === 0 || data.stop_reason === "end_turn") break;

      var toolResults = [];
      for (var j = 0; j < toolUseBlocks.length; j++) {
        var toolCall = toolUseBlocks[j];
        var result;
        try {
          if (useRealDocuSign) {
            result = await executeRealTool(toolCall.name, toolCall.input);
          } else {
            result = executeMockTool(toolCall.name, toolCall.input);
          }
        } catch (err) {
          result = { error: "Error ejecutando " + toolCall.name + ": " + err.message };
        }

        toolTrace.push({ tool: toolCall.name, input: toolCall.input, result: result });
        toolResults.push({ type: "tool_result", tool_use_id: toolCall.id, content: JSON.stringify(result) });
      }

      currentMessages.push({ role: "assistant", content: data.content });
      currentMessages.push({ role: "user", content: toolResults });
    }

    var assistantText = responseBlocks.map(function (b) { return b.text; }).join("\n\n");
    if (assistantText) session.messages.push({ role: "assistant", content: assistantText });

    res.json({ text: assistantText, tools: toolTrace, mode: useRealDocuSign ? "live" : "demo", docusign_connected: hasDocuSignConfig });
  } catch (error) {
    console.error("Chat error:", error.message);
    res.status(500).json({ error: "Error al procesar el mensaje", detail: error.message });
  }
});

// ─── Status endpoint ────────────────────────────────────────────────────
app.get("/api/status", async function (req, res) {
  var status = { anthropic: !!ANTHROPIC_API_KEY, docusign_configured: hasDocuSignConfig, docusign_connected: false };

  if (hasDocuSignConfig) {
    try {
      var token = await getDocuSignToken();
      var userRes = await fetch(DS_CONFIG.oauthBasePath + "/oauth/userinfo", { headers: { Authorization: "Bearer " + token } });
      if (userRes.ok) {
        var userData = await userRes.json();
        status.docusign_connected = true;
        status.docusign_user = userData.name;
        status.docusign_email = userData.email;
      }
    } catch (err) {
      status.docusign_error = err.message;
    }
  }
  res.json(status);
});

// ─── Reset ──────────────────────────────────────────────────────────────
app.post("/api/reset", function (req, res) {
  sessions.delete(req.body.sessionId || "default");
  res.json({ ok: true });
});

// ─── Health ─────────────────────────────────────────────────────────────
app.get("/api/health", function (req, res) {
  res.json({ status: "ok", hasApiKey: !!ANTHROPIC_API_KEY, hasDocuSign: hasDocuSignConfig });
});

// ─── Catch-all ──────────────────────────────────────────────────────────
app.get("*", function (req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, function () {
  console.log("\n  🚀 DocuSign MCP Demo on http://localhost:" + PORT);
  console.log("  🔑 Anthropic: " + (ANTHROPIC_API_KEY ? "✅" : "⚠️  MISSING"));
  console.log("  📡 DocuSign: " + (hasDocuSignConfig ? "✅ REAL" : "⚠️  DEMO mode"));
  console.log();
});

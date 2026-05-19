// ─── State ──────────────────────────────────────────────────
let currentMode = 'demo';
let isProcessing = false;
let sessionId = sessionStorage.getItem('mcp_session') || null;
let logsVisible = true;
let currentAbort = null;
let coldStartTimer = null;

const msgEl  = document.getElementById('messages');
const inputEl = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');

// ─── Init ───────────────────────────────────────────────────
window.addEventListener('load', () => {
  setTimeout(() => document.getElementById('loader').classList.add('hidden'), 600);
  startMetricsTicker();
  checkStatus();

  document.getElementById('mode-demo').addEventListener('click', () => setMode('demo'));
  document.getElementById('mode-live').addEventListener('click', () => setMode('live'));
  sendBtn.addEventListener('click', sendMessage);
  document.getElementById('btn-reset').addEventListener('click', resetChat);
  document.getElementById('logs-toggle').addEventListener('click', toggleLogs);

  const scrollBtn = document.getElementById('scroll-bottom');
  scrollBtn.addEventListener('click', () => msgEl.scrollTo({ top: msgEl.scrollHeight, behavior: 'smooth' }));
  msgEl.addEventListener('scroll', () => {
    const atBottom = msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight < 60;
    scrollBtn.classList.toggle('show', !atBottom);
  });

  inputEl.addEventListener('input', updateCharCount);
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Event delegation for collapsible MCP blocks (replaces inline onclick attrs)
  msgEl.addEventListener('click', e => {
    const block = e.target.closest('.mcp-block');
    if (block) { block.classList.toggle('expanded'); return; }
    const rh = e.target.closest('.mcp-result-header');
    if (rh) rh.closest('.mcp-result').classList.toggle('expanded');
  });

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('show'));
      tab.classList.add('active');
      document.getElementById('panel-' + tab.dataset.tab).classList.add('show');
    });
  });

  // Scenario quick-prompts
  document.querySelectorAll('.sc-btn[data-prompt]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (isProcessing) return;
      inputEl.value = btn.dataset.prompt;
      updateCharCount();
      sendMessage();
    });
  });

  // Code-box copy
  const codeCopyBtn = document.getElementById('code-copy-btn');
  if (codeCopyBtn) {
    codeCopyBtn.addEventListener('click', () => {
      const box = document.querySelector('.code-box');
      if (!box) return;
      navigator.clipboard.writeText(box.textContent.trim()).then(() => {
        codeCopyBtn.classList.add('copied');
        setTimeout(() => codeCopyBtn.classList.remove('copied'), 2000);
      }).catch(() => {});
    });
  }
});

// ─── Logs toggle ────────────────────────────────────────────
function toggleLogs() {
  logsVisible = !logsVisible;
  document.getElementById('logs-toggle').classList.toggle('active', logsVisible);
  document.querySelectorAll('.mcp-block, .mcp-result').forEach(el => {
    el.classList.toggle('logs-hidden', !logsVisible);
  });
}

// ─── Mode toggle ────────────────────────────────────────────
function setMode(mode) {
  currentMode = mode;
  const demoBtn = document.getElementById('mode-demo');
  const liveBtn = document.getElementById('mode-live');
  demoBtn.classList.toggle('active', mode === 'demo');
  liveBtn.classList.toggle('active', mode === 'live');
  demoBtn.setAttribute('aria-pressed', String(mode === 'demo'));
  liveBtn.setAttribute('aria-pressed', String(mode === 'live'));
  const label = document.getElementById('chat-mode-label');
  label.textContent = mode === 'live' ? 'En vivo' : 'Demo';
  label.className   = mode === 'live' ? 'mode-label live' : 'mode-label demo';
}

// ─── Status check ───────────────────────────────────────────
async function checkStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();
    if (data.docusign_connected) {
      document.getElementById('chat-meta').textContent =
        'claude-haiku-4.5 · DocuSign ✓' + (data.docusign_user ? ' ' + data.docusign_user : '');
    }
  } catch (_) {}
}

// ─── Metrics ticker + count-up ──────────────────────────────
const baseMetrics = { envelopes: 142, pending: 38, idv: 1247, workflows: 7 };

function countUp(elId, target, duration) {
  const el = document.getElementById(elId);
  if (!el) return;
  const start = performance.now();
  const fmt = n => n >= 1000 ? n.toLocaleString('es-MX') : String(n);
  const tick = now => {
    const t = Math.min((now - start) / duration, 1);
    const ease = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(Math.round(target * ease));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function startMetricsTicker() {
  // Count-up on load
  setTimeout(() => {
    countUp('metric-envelopes', baseMetrics.envelopes, 1100);
    countUp('metric-pending',   baseMetrics.pending,    850);
    countUp('metric-idv',       baseMetrics.idv,       1400);
    countUp('metric-workflows', baseMetrics.workflows,  600);
  }, 750);

  // Live ticker
  setInterval(() => {
    const env = baseMetrics.envelopes + Math.floor(Math.random() * 4) - 1;
    const pen = baseMetrics.pending  + Math.floor(Math.random() * 3) - 1;
    const idv = baseMetrics.idv      + Math.floor(Math.random() * 5);
    document.getElementById('metric-envelopes').textContent = env;
    document.getElementById('metric-pending').textContent   = pen;
    document.getElementById('metric-idv').textContent       = idv.toLocaleString('es-MX');
    baseMetrics.idv = idv;
  }, 8000);
}

// ─── Send message ───────────────────────────────────────────
async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || isProcessing) return;

  isProcessing = true;
  sendBtn.disabled = true;
  inputEl.value = '';
  updateCharCount();
  document.querySelector('.input-bar').classList.add('processing');
  const bar = document.getElementById('nprogress');
  if (bar) { bar.classList.remove('done'); bar.classList.add('active'); }

  const empty = msgEl.querySelector('.empty-state');
  if (empty) empty.remove();

  addMsg('user', text);
  const typingId = showTyping('Consultando DocuSign…');

  coldStartTimer = setTimeout(() => {
    document.getElementById('cold-banner').classList.add('show');
  }, 8000);

  if (currentAbort) currentAbort.abort();
  currentAbort = new AbortController();
  const timeoutId = setTimeout(() => currentAbort.abort(), 35000);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId, mode: currentMode }),
      signal: currentAbort.signal,
    });

    clearTimeout(timeoutId);
    clearTimeout(coldStartTimer);
    document.getElementById('cold-banner').classList.remove('show');
    removeTyping(typingId);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Error del servidor');
    }

    const data = await res.json();
    if (data.sessionId) {
      sessionId = data.sessionId;
      sessionStorage.setItem('mcp_session', sessionId);
    }

    if (data.tools && data.tools.length > 0) {
      for (const t of data.tools) {
        if (t.tool)   { addMcpCall(t.tool, t.input); await sleep(280); }
        if (t.result) { addMcpResult(t.result);      await sleep(280); }
      }
    }

    if (data.text) addMsg('assistant', data.text);

  } catch (err) {
    clearTimeout(timeoutId);
    clearTimeout(coldStartTimer);
    document.getElementById('cold-banner').classList.remove('show');
    removeTyping(typingId);
    const msg = err.name === 'AbortError'
      ? 'La solicitud tardó demasiado. Verifica tu conexión e intenta de nuevo.'
      : 'No se pudo completar la solicitud. Intenta de nuevo.';
    addMsg('assistant', msg, true);
  }

  isProcessing = false;
  sendBtn.disabled = false;
  document.querySelector('.input-bar').classList.remove('processing');
  const barEl = document.getElementById('nprogress');
  if (barEl) { barEl.classList.remove('active'); barEl.classList.add('done'); }
  inputEl.focus();
}

// ─── Char counter ────────────────────────────────────────────
function updateCharCount() {
  const len = inputEl.value.length;
  const el  = document.getElementById('char-count');
  if (!el) return;
  if (len === 0) { el.className = 'char-count'; el.textContent = ''; return; }
  el.textContent = len + '/4000';
  el.className   = 'char-count visible' + (len > 3800 ? ' over' : len > 3200 ? ' warn' : '');
}

// ─── Timestamp ───────────────────────────────────────────────
function getTimestamp() {
  return new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

// ─── Toast ───────────────────────────────────────────────────
function showToast(msg, duration = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

// ─── Chat helpers ────────────────────────────────────────────
function addMsg(role, text, isError = false) {
  const div  = document.createElement('div');
  const time = getTimestamp();

  if (role === 'user') {
    div.className = 'msg msg-user';
    div.innerHTML = `<div class="bubble">${esc(text)}<div class="msg-time">${time}</div></div>
      <div class="avatar avatar-user" aria-hidden="true">Tú</div>`;
  } else {
    div.className = 'msg msg-ai';
    const formatted = esc(text).replace(/\n/g, '<br>');
    div.innerHTML = `<div class="avatar avatar-agent" aria-hidden="true">DS</div>
      <div class="bubble">
        <div class="src">Agente MCP
          <button class="copy-btn" aria-label="Copiar respuesta" title="Copiar">
            <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>
        <div class="response-text${isError ? ' response-error' : ''}">${isError ? '⚠️ ' : ''}${formatted}</div>
        <div class="msg-time">${time}</div>
      </div>`;
    div.querySelector('.copy-btn').addEventListener('click', function () {
      navigator.clipboard.writeText(text).then(() => {
        this.classList.add('copied');
        setTimeout(() => this.classList.remove('copied'), 2000);
      }).catch(() => {});
    });
  }
  msgEl.appendChild(div);
  msgEl.scrollTop = msgEl.scrollHeight;
}

function addMcpCall(tool, input) {
  const div = document.createElement('div');
  div.className = 'msg';
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  const hidden   = logsVisible ? '' : 'logs-hidden';
  div.innerHTML = `<div class="mcp-block ${hidden}">
    <div class="mcp-summary">
      <div class="mcp-badge" style="margin-bottom:0">
        <span class="tag">MCP</span>
        <span>tool_use</span>
        <span class="fn">${esc(tool)}</span>
      </div>
      <svg class="mcp-chevron" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="mcp-detail"><pre>${esc(inputStr)}</pre></div>
  </div>`;
  msgEl.appendChild(div);
  msgEl.scrollTop = msgEl.scrollHeight;
}

function addMcpResult(result) {
  const div = document.createElement('div');
  div.className = 'msg';

  let data = result;
  if (typeof result === 'string') {
    try { data = JSON.parse(result); } catch { data = { raw: result }; }
  }

  let inner = '', resultCount = '';

  if (data.envelopes && Array.isArray(data.envelopes)) {
    resultCount = ` · ${data.envelopes.length} resultado${data.envelopes.length === 1 ? '' : 's'}`;
    inner = data.envelopes.map(e => {
      const s = e.status || 'unknown';
      const p = s === 'completed' ? 'pill-green'
        : s === 'voided' || s === 'declined' ? 'pill-red'
        : s === 'pending' || s === 'sent' || s === 'created' ? 'pill-amber' : 'pill-blue';
      return `<div class="result-item">
        <div class="ri-name">${esc(e.subject || e.name || 'Sin asunto')}</div>
        <div class="ri-meta">
          <span class="pill ${p}">${esc(s)}</span>
          ${e.signers_progress ? `<span class="meta-sm">${esc(e.signers_progress)} firmas</span>` : ''}
          ${e.created     ? `<span class="meta-sm">${esc(formatDate(e.created))}</span>` : ''}
          ${e.envelope_id ? `<span class="meta-sm">${esc(e.envelope_id)}</span>` : ''}
        </div>
      </div>`;
    }).join('');
  } else if (data.templates && Array.isArray(data.templates)) {
    resultCount = ` · ${data.templates.length} template${data.templates.length === 1 ? '' : 's'}`;
    inner = data.templates.map(t => `<div class="result-item">
      <div class="ri-name">${esc(t.name)}</div>
      <div class="ri-meta">
        <span class="pill pill-blue">template</span>
        ${t.template_id   ? `<span class="meta-sm">${esc(t.template_id)}</span>` : ''}
        ${t.last_modified ? `<span class="meta-sm">${esc(formatDate(t.last_modified))}</span>` : ''}
      </div>
    </div>`).join('');
  } else if (data.signers && Array.isArray(data.signers)) {
    resultCount = ` · ${data.signers.length} firmante${data.signers.length === 1 ? '' : 's'}`;
    inner = data.signers.map(s => {
      const st = s.status || 'unknown';
      const p  = st === 'completed' ? 'pill-green' : st === 'declined' ? 'pill-red' : 'pill-amber';
      return `<div class="result-item">
        <div class="ri-name">${esc(s.name)} <span style="color:var(--ink-3);font-weight:400;font-size:11px">${esc(s.email || '')}</span></div>
        <div class="ri-meta">
          <span class="pill ${p}">${esc(st)}</span>
          ${s.role ? `<span class="meta-sm">${esc(s.role)}</span>` : ''}
        </div>
      </div>`;
    }).join('');
  } else if (data.envelope_id && data.subject) {
    inner = `<div class="result-item">
      <div class="ri-name">${esc(data.subject)}</div>
      <div class="ri-meta">
        <span class="pill pill-blue">${esc(data.status || 'envelope')}</span>
        <span class="meta-sm">ID: ${esc(data.envelope_id)}</span>
        ${data.created ? `<span class="meta-sm">${esc(formatDate(data.created))}</span>` : ''}
        ${data.sender  ? `<span class="meta-sm">por ${esc(data.sender)}</span>` : ''}
      </div>
    </div>`;
  } else if (data.success !== undefined || data.message) {
    const ok = data.success !== false;
    inner = `<div class="result-item">
      <div class="ri-name">${esc(data.message || (ok ? 'Acción completada' : 'Error'))}</div>
      <div class="ri-meta">
        <span class="pill ${ok ? 'pill-green' : 'pill-red'}">${ok ? 'OK' : 'Error'}</span>
        ${data.envelope_id ? `<span class="meta-sm">ID: ${esc(data.envelope_id)}</span>` : ''}
      </div>
    </div>`;
  } else if (data.error) {
    inner = `<div class="result-item"><div class="ri-name" style="color:var(--danger)">⚠️ ${esc(data.error)}</div></div>`;
  } else {
    inner = `<div class="result-item"><pre style="font-size:11px;color:var(--ink-3);white-space:pre-wrap;margin:0;font-family:var(--font-mono)">${esc(JSON.stringify(data, null, 2))}</pre></div>`;
  }

  const hidden = logsVisible ? '' : 'logs-hidden';
  div.innerHTML = `<div class="mcp-result ${hidden}">
    <div class="mcp-result-header" style="display:flex;align-items:center;gap:6px">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px"><polyline points="20 6 9 17 4 12"/></svg>
      Respuesta DocuSign${resultCount}
      <svg class="mcp-result-chevron" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="mcp-result-body">${inner}</div>
  </div>`;
  msgEl.appendChild(div);
  msgEl.scrollTop = msgEl.scrollHeight;
}

function showTyping(label) {
  const id  = 'typ-' + Date.now();
  const div = document.createElement('div');
  div.id        = id;
  div.className = 'msg msg-ai';
  div.innerHTML = `<div class="avatar avatar-agent" aria-hidden="true">DS</div>
    <div class="typing">
      <div class="typing-dots"><i></i><i></i><i></i></div>
      <span>${esc(label)}</span>
    </div>`;
  msgEl.appendChild(div);
  msgEl.scrollTop = msgEl.scrollHeight;
  return id;
}

function removeTyping(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// ─── Reset chat ──────────────────────────────────────────────
async function resetChat() {
  try {
    if (sessionId) await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  } catch (_) {}
  sessionId = null;
  sessionStorage.removeItem('mcp_session');
  msgEl.innerHTML = emptyStateHTML();
  showToast('Conversación limpiada');
}

function emptyStateHTML() {
  return `<div class="empty-state">
    <div class="empty-illustration">
      <svg viewBox="0 0 120 140" xmlns="http://www.w3.org/2000/svg">
        <rect x="8" y="8" width="104" height="124" rx="10" fill="rgba(255,204,34,0.05)" stroke="rgba(255,204,34,0.18)" stroke-width="1.5"/>
        <rect x="8" y="8" width="104" height="30" rx="10" fill="rgba(255,204,34,0.10)"/>
        <rect x="8" y="28" width="104" height="10" fill="rgba(255,204,34,0.10)"/>
        <text x="60" y="28" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" font-weight="800" fill="#FFCC22">DocuSign</text>
        <rect x="20" y="50" width="80" height="3" rx="1.5" fill="rgba(255,255,255,0.10)"/>
        <rect x="20" y="60" width="64" height="3" rx="1.5" fill="rgba(255,255,255,0.07)"/>
        <rect x="20" y="70" width="72" height="3" rx="1.5" fill="rgba(255,255,255,0.07)"/>
        <rect x="20" y="80" width="52" height="3" rx="1.5" fill="rgba(255,255,255,0.07)"/>
        <line x1="20" y1="112" x2="84" y2="112" stroke="rgba(255,204,34,0.35)" stroke-width="1" stroke-dasharray="3,3"/>
        <text x="20" y="124" font-family="Arial,sans-serif" font-size="8" fill="rgba(255,204,34,0.45)">Firma aquí</text>
        <path d="M 26 106 Q 36 96 46 106 Q 56 116 66 103 Q 74 93 80 103" stroke="rgba(255,204,34,0.75)" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        <g transform="translate(98,95) rotate(-35)">
          <rect x="-3" y="-14" width="6" height="14" rx="2" fill="#FFCC22" opacity="0.85"/>
          <polygon points="0,-16 -3,-13 3,-13" fill="#FFCC22" opacity="0.85"/>
          <rect x="-3" y="0" width="6" height="4" rx="1" fill="rgba(255,255,255,0.3)"/>
        </g>
        <circle cx="98" cy="95" r="10" fill="rgba(255,204,34,0.07)"/>
      </svg>
    </div>
    <div class="empty-title">Listo para trabajar</div>
    <div class="empty-desc">Escribe un mensaje o selecciona un <strong>escenario</strong><br>para interactuar con DocuSign vía MCP</div>
  </div>`;
}

// ─── Utils ───────────────────────────────────────────────────
function esc(s) {
  if (s === null || s === undefined) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatDate(s) {
  if (!s) return '';
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return s; }
}

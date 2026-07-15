/*
 * Claude Mobile — chat with Claude on any device via the Anthropic API.
 * Works on iOS/iPadOS/Android/desktop. No CLI, no Node, no child processes.
 *
 * Tools exposed to Claude (all implemented on Obsidian's Vault API):
 *   read_note, get_active_note, list_folder, search_vault  (read-only, auto-run)
 *   create_note, update_note                                (require user approval)
 */

'use strict';

const {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  Notice,
  MarkdownRenderer,
  FuzzySuggestModal,
  TFile,
  TFolder,
  normalizePath,
  requestUrl,
} = require('obsidian');

const VIEW_TYPE = 'claude-mobile-view';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** Stored per-device (Obsidian localStorage), never written to synced data.json. */
const SECRET_KEYS = ['apiKey', 'relayToken'];
/**
 * localStorage key prefix. Deliberately kept at the pre-rename value
 * ("claude-mobile:") so existing devices don't lose stored secrets when the
 * plugin was renamed to "Vault Companion for Claude". Do not change.
 */
const LS_PREFIX = 'claude-mobile:';

const DEFAULT_SETTINGS = {
  backend: 'api', // 'api' (Anthropic API key) | 'relay' (Mac relay / Claude subscription)
  apiKey: '',
  relayUrl: '',
  relayToken: '',
  model: 'claude-sonnet-5',
  maxTokens: 8192,
  includeClaudeMd: true,
  extraSystemPrompt: '',
  maxToolIterations: 15,
  autoApprove: false, // "YOLO" mode: skip all approval cards
  excludedFolders: '', // newline/comma-separated path prefixes hidden from Claude
  respectObsidianExcludes: true, // also honor Options → Files & links → Excluded files
};

/* ------------------------------------------------------------------ */
/* Tool definitions (Anthropic tool-use schema)                        */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: 'read_note',
    description:
      'Read the full content of a note or file in the vault. Path is relative to the vault root, e.g. "wiki/concepts/data-vault-2.md".',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path to the file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_active_note',
    description: 'Get the path and full content of the note currently open in the editor.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_folder',
    description:
      'List files and subfolders of a vault folder. Use "/" for the vault root.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative folder path, "/" for root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_vault',
    description:
      'Search markdown notes by filename and content (case-insensitive substring match). Returns matching paths with content snippets. Files larger than 300 KB are matched by filename only.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for' },
        folder: {
          type: 'string',
          description: 'Optional: restrict search to this folder (vault-relative path)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_note',
    description:
      'Create a new note in the vault. The user must approve before it is written. Missing parent folders are created automatically.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path for the new file (must end in .md)' },
        content: { type: 'string', description: 'Full markdown content of the note' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'update_note',
    description:
      'Replace the full content of an existing note. The user must approve before it is written. Always read_note first so you preserve content you do not intend to change.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path of the existing file' },
        content: { type: 'string', description: 'The complete new content of the note' },
      },
      required: ['path', 'content'],
    },
  },
];

const READ_CAP = 60000; // chars returned per file read
const SEARCH_MAX_FILES = 15;
const SEARCH_CONTENT_MAX_BYTES = 300 * 1024;
const CONTEXT_FILE_CAP = 20000; // chars per context document injected into the prompt

/* ------------------------------------------------------------------ */
/* Exclusions (private folders hidden from Claude)                     */
/* ------------------------------------------------------------------ */

/**
 * Compile exclusion rules from the plugin's own "excluded folders" setting
 * plus (optionally) Obsidian's Options → Files & links → Excluded files.
 * Obsidian entries wrapped in slashes are regexes; others are path prefixes.
 */
function exclusionRules(app, settings) {
  const prefixes = String(settings.excludedFolders || '')
    .split(/[\n,]/)
    .map((s) => normalizePath(s.trim().replace(/\/+$/, '')))
    .filter((s) => s && s !== '/');
  const regexes = [];
  if (settings.respectObsidianExcludes && app.vault.getConfig) {
    const filters = app.vault.getConfig('userIgnoreFilters') || [];
    for (const f of filters) {
      if (typeof f !== 'string' || !f) continue;
      if (f.length > 2 && f.startsWith('/') && f.endsWith('/')) {
        try {
          regexes.push(new RegExp(f.slice(1, -1), 'i'));
        } catch (_) {
          /* invalid regex in Obsidian settings: ignore */
        }
      } else {
        const p = normalizePath(f.replace(/\/+$/, ''));
        if (p && p !== '/') prefixes.push(p);
      }
    }
  }
  return { prefixes: prefixes, regexes: regexes };
}

/** Case-insensitive match on folder boundaries ("private" ≠ "privateer.md"). */
function isPathExcluded(path, rules) {
  const p = normalizePath(path).toLowerCase();
  for (const pre of rules.prefixes) {
    const pl = pre.toLowerCase();
    if (p === pl || p.startsWith(pl + '/')) return true;
  }
  for (const re of rules.regexes) {
    if (re.test(path)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Chat context (active note + pinned documents)                       */
/* ------------------------------------------------------------------ */

/** Per-chat context set: the live active note plus manually pinned documents. */
class ChatContext {
  constructor() {
    this.reset();
  }

  reset() {
    this.pinned = [];
    this.includeActive = true;
    this.lastSentSignature = null; // relay backend: context block sent when this changes
  }

  pin(path) {
    if (!this.pinned.includes(path)) this.pinned.push(path);
  }

  unpin(path) {
    this.pinned = this.pinned.filter((p) => p !== path);
  }

  /** Active note first (when enabled), then pinned docs, deduplicated. */
  resolvePaths(activePath) {
    const out = [];
    if (this.includeActive && activePath) out.push(activePath);
    for (const p of this.pinned) if (!out.includes(p)) out.push(p);
    return out;
  }
}

/** Read context documents; missing files come back as { path, missing: true }. */
async function readContextDocs(app, paths) {
  const docs = [];
  for (const path of paths) {
    const f = app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(f instanceof TFile)) {
      docs.push({ path: path, missing: true });
      continue;
    }
    let content = await app.vault.cachedRead(f);
    let truncated = false;
    if (content.length > CONTEXT_FILE_CAP) {
      content = content.slice(0, CONTEXT_FILE_CAP);
      truncated = true;
    }
    docs.push({ path: path, content: content, truncated: truncated, mtime: f.stat.mtime });
  }
  return docs;
}

function buildContextSection(docs) {
  const present = docs.filter((d) => !d.missing);
  if (!present.length) return '';
  let out =
    '\n\n--- CONTEXT DOCUMENTS (attached by the user; content is already provided below, no need to read these files again) ---';
  for (const d of present) {
    out += '\n\n=== ' + d.path + ' ===\n' + d.content;
    if (d.truncated)
      out += '\n[... truncated at ' + CONTEXT_FILE_CAP + ' characters — use read_note for the rest ...]';
  }
  out += '\n--- END CONTEXT DOCUMENTS ---';
  return out;
}

/** Cheap change signature: paths + mtimes (content changes bump mtime). */
function contextSignature(docs) {
  return docs
    .filter((d) => !d.missing)
    .map((d) => d.path + ':' + (d.mtime || 0))
    .join('|');
}

/**
 * Relay backend: the server-side session already holds earlier turns, so the
 * context block is prepended only when the context set changed since the last
 * message in this session.
 */
function buildRelayPrompt(text, docs, lastSig) {
  const sig = contextSignature(docs);
  if (!docs.length || sig === lastSig) return { prompt: text, sig: sig };
  return { prompt: buildContextSection(docs).trim() + '\n\n' + text, sig: sig };
}

/** Fuzzy picker over all markdown files, used by the "+" button in the context bar. */
class ContextFileSuggestModal extends FuzzySuggestModal {
  constructor(app, onChoose, isExcluded) {
    super(app);
    this.onChoose = onChoose;
    this.isExcluded = isExcluded || (() => false);
    this.setPlaceholder('Add a note to the chat context…');
  }
  getItems() {
    return this.app.vault.getMarkdownFiles().filter((f) => !this.isExcluded(f.path));
  }
  getItemText(f) {
    return f.path;
  }
  onChooseItem(f) {
    this.onChoose(f.path);
  }
}

/* ------------------------------------------------------------------ */
/* Anthropic API client                                                */
/* ------------------------------------------------------------------ */

/**
 * Call the Messages API. Streams when possible, falls back to requestUrl.
 * Returns { blocks, stopReason }. Emits partial text via onText(delta).
 */
async function callClaude({ settings, system, messages, signal, onText }) {
  const body = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    system: system,
    messages: messages,
    tools: TOOLS,
  };

  // Preferred path: fetch with streaming (works in Obsidian desktop + mobile webview).
  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      signal: signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(Object.assign({ stream: true }, body)),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new ApiError(resp.status, errText);
    }
    return await parseSseStream(resp, onText);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    if (e instanceof ApiError) throw e;
    // fetch itself failed (CORS / network quirk) → non-streaming fallback
    console.warn('Claude Mobile: streaming fetch failed, falling back to requestUrl', e);
  }

  const r = await requestUrl({
    url: API_URL,
    method: 'POST',
    contentType: 'application/json',
    headers: {
      'x-api-key': settings.apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(body),
    throw: false,
  });
  if (r.status >= 400) throw new ApiError(r.status, r.text);
  const data = r.json;
  for (const b of data.content) {
    if (b.type === 'text' && onText) onText(b.text);
  }
  return { blocks: data.content, stopReason: data.stop_reason };
}

class ApiError extends Error {
  constructor(status, bodyText) {
    let msg = 'API error ' + status;
    try {
      const j = JSON.parse(bodyText);
      if (j.error && j.error.message) msg += ': ' + j.error.message;
    } catch (_) {
      if (bodyText) msg += ': ' + String(bodyText).slice(0, 300);
    }
    super(msg);
    this.status = status;
  }
}

async function parseSseStream(resp, onText) {
  const blocks = [];
  let stopReason = null;
  // per-index accumulation state
  const partialJson = {};

  const handleEvent = (data) => {
    let ev;
    try {
      ev = JSON.parse(data);
    } catch (_) {
      return;
    }
    switch (ev.type) {
      case 'content_block_start': {
        const b = ev.content_block;
        if (b.type === 'tool_use') {
          blocks[ev.index] = { type: 'tool_use', id: b.id, name: b.name, input: {} };
          partialJson[ev.index] = '';
        } else if (b.type === 'text') {
          blocks[ev.index] = { type: 'text', text: b.text || '' };
          if (b.text && onText) onText(b.text);
        } else {
          blocks[ev.index] = b;
        }
        break;
      }
      case 'content_block_delta': {
        const blk = blocks[ev.index];
        if (!blk) break;
        if (ev.delta.type === 'text_delta') {
          blk.text += ev.delta.text;
          if (onText) onText(ev.delta.text);
        } else if (ev.delta.type === 'input_json_delta') {
          partialJson[ev.index] += ev.delta.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const blk = blocks[ev.index];
        if (blk && blk.type === 'tool_use') {
          try {
            blk.input = partialJson[ev.index] ? JSON.parse(partialJson[ev.index]) : {};
          } catch (e) {
            blk.input = {};
          }
        }
        break;
      }
      case 'message_delta': {
        if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
        break;
      }
      case 'error': {
        const m = ev.error && ev.error.message ? ev.error.message : 'stream error';
        throw new ApiError(0, JSON.stringify({ error: { message: m } }));
      }
    }
  };

  const feed = (text, buf) => {
    buf.data += text;
    let idx;
    while ((idx = buf.data.indexOf('\n\n')) !== -1) {
      const rawEvent = buf.data.slice(0, idx);
      buf.data = buf.data.slice(idx + 2);
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) handleEvent(line.slice(5).trim());
      }
    }
  };

  const buf = { data: '' };
  if (resp.body && resp.body.getReader) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }), buf);
    }
  } else {
    // No ReadableStream support: body arrives whole, still SSE-formatted.
    feed(await resp.text(), buf);
  }

  return { blocks: blocks.filter(Boolean), stopReason: stopReason };
}

/* ------------------------------------------------------------------ */
/* Vault tool execution                                                */
/* ------------------------------------------------------------------ */

class VaultTools {
  constructor(app, requestApproval, isExcluded) {
    this.app = app;
    this.requestApproval = requestApproval; // async (toolName, input) => boolean
    this.isExcluded = isExcluded || (() => false); // (path) => boolean
  }

  async execute(name, input) {
    try {
      switch (name) {
        case 'read_note':
          return await this.readNote(input.path);
        case 'get_active_note':
          return await this.getActiveNote();
        case 'list_folder':
          return this.listFolder(input.path);
        case 'search_vault':
          return await this.searchVault(input.query, input.folder);
        case 'create_note':
          return await this.createNote(input.path, input.content);
        case 'update_note':
          return await this.updateNote(input.path, input.content);
        default:
          return { ok: false, text: 'Unknown tool: ' + name };
      }
    } catch (e) {
      return { ok: false, text: 'Tool error: ' + (e && e.message ? e.message : String(e)) };
    }
  }

  getFile(path) {
    const p = normalizePath(path);
    if (this.isExcluded(p)) return null; // excluded paths behave as nonexistent
    const f = this.app.vault.getAbstractFileByPath(p);
    return f instanceof TFile ? f : null;
  }

  async readNote(path) {
    const f = this.getFile(path);
    if (!f) return { ok: false, text: 'File not found: ' + path };
    let content = await this.app.vault.cachedRead(f);
    let note = '';
    if (content.length > READ_CAP) {
      content = content.slice(0, READ_CAP);
      note = '\n\n[... truncated at ' + READ_CAP + ' characters ...]';
    }
    return { ok: true, text: content + note };
  }

  async getActiveNote() {
    const f = this.app.workspace.getActiveFile();
    if (!f || this.isExcluded(f.path)) return { ok: false, text: 'No note is currently active.' };
    const r = await this.readNote(f.path);
    return { ok: r.ok, text: 'Active note: ' + f.path + '\n\n' + r.text };
  }

  listFolder(path) {
    const p = !path || path === '/' ? '/' : normalizePath(path);
    if (p !== '/' && this.isExcluded(p)) return { ok: false, text: 'Folder not found: ' + path };
    const folder =
      p === '/' ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(p);
    if (!(folder instanceof TFolder)) return { ok: false, text: 'Folder not found: ' + path };
    const lines = folder.children
      .filter((c) => !this.isExcluded(c.path))
      .map((c) => (c instanceof TFolder ? c.name + '/' : c.name))
      .sort();
    return { ok: true, text: lines.join('\n') || '(empty folder)' };
  }

  async searchVault(query, folder) {
    if (!query) return { ok: false, text: 'Empty query.' };
    const q = query.toLowerCase();
    const prefix = folder ? normalizePath(folder) + '/' : null;
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => (!prefix || f.path.startsWith(prefix)) && !this.isExcluded(f.path));

    const nameHits = [];
    const contentHits = [];

    for (const f of files) {
      const nameMatch = f.path.toLowerCase().includes(q);
      if (nameMatch) nameHits.push(f.path);
      if (contentHits.length >= SEARCH_MAX_FILES) continue;
      if (f.stat.size > SEARCH_CONTENT_MAX_BYTES) continue;
      const content = await this.app.vault.cachedRead(f);
      const lower = content.toLowerCase();
      let pos = lower.indexOf(q);
      if (pos === -1) continue;
      const snippets = [];
      let count = 0;
      while (pos !== -1 && count < 3) {
        const start = Math.max(0, pos - 100);
        const end = Math.min(content.length, pos + q.length + 150);
        snippets.push('…' + content.slice(start, end).replace(/\n+/g, ' ') + '…');
        pos = lower.indexOf(q, end);
        count++;
      }
      contentHits.push({ path: f.path, snippets: snippets });
    }

    if (!nameHits.length && !contentHits.length)
      return { ok: true, text: 'No matches for "' + query + '".' };

    let out = '';
    if (nameHits.length) {
      out += 'Filename matches:\n' + nameHits.slice(0, 25).map((p) => '- ' + p).join('\n') + '\n\n';
    }
    if (contentHits.length) {
      out += 'Content matches:\n';
      for (const h of contentHits) {
        out += '- ' + h.path + '\n';
        for (const s of h.snippets) out += '    ' + s + '\n';
      }
    }
    return { ok: true, text: out.trim() };
  }

  async ensureParentFolders(path) {
    const parts = path.split('/');
    parts.pop();
    if (!parts.length) return;
    let cur = '';
    for (const part of parts) {
      cur = cur ? cur + '/' + part : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        await this.app.vault.createFolder(cur);
      }
    }
  }

  async createNote(path, content) {
    const p = normalizePath(path);
    if (this.isExcluded(p))
      return { ok: false, text: 'Cannot create note at ' + p + ': this location is not accessible.' };
    if (this.app.vault.getAbstractFileByPath(p))
      return { ok: false, text: 'File already exists: ' + p + '. Use update_note instead.' };
    const approved = await this.requestApproval('create_note', { path: p, content: content });
    if (!approved) return { ok: false, text: 'User rejected the creation of ' + p + '.' };
    await this.ensureParentFolders(p);
    await this.app.vault.create(p, content);
    return { ok: true, text: 'Created ' + p + ' (' + content.length + ' chars).' };
  }

  async updateNote(path, content) {
    const p = normalizePath(path);
    const f = this.getFile(p);
    if (!f) return { ok: false, text: 'File not found: ' + p + '. Use create_note for new files.' };
    const old = await this.app.vault.cachedRead(f);
    const approved = await this.requestApproval('update_note', {
      path: p,
      content: content,
      oldLength: old.length,
    });
    if (!approved) return { ok: false, text: 'User rejected the update of ' + p + '.' };
    await this.app.vault.modify(f, content);
    return { ok: true, text: 'Updated ' + p + ' (' + old.length + ' → ' + content.length + ' chars).' };
  }
}

/* ------------------------------------------------------------------ */
/* Chat view                                                           */
/* ------------------------------------------------------------------ */

class ClaudeMobileView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.messages = []; // Anthropic message history (API backend)
    this.sessionId = null; // Agent SDK session (relay backend)
    this.running = false;
    this.abortController = null;
    this.context = new ChatContext();
    this.tools = new VaultTools(
      this.app,
      (name, input) => this.requestApproval(name, input),
      (path) => this.isPathExcluded(path)
    );
  }

  isPathExcluded(path) {
    return isPathExcluded(path, exclusionRules(this.app, this.plugin.settings));
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return 'Claude';
  }
  getIcon() {
    return 'bot-message-square';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('claude-mobile-root');

    const header = root.createDiv({ cls: 'claude-mobile-header' });
    header.createSpan({ text: 'Claude', cls: 'claude-mobile-title' });
    const s = this.plugin.settings;
    this.modelLabel = header.createSpan({
      text:
        (s.backend === 'relay' ? 'Mac relay (subscription)' : s.model) +
        (s.autoApprove ? ' · YOLO' : ''),
      cls: 'claude-mobile-model',
    });
    const newChatBtn = header.createEl('button', { text: 'New chat', cls: 'claude-mobile-btn' });
    newChatBtn.onclick = () => this.resetChat();

    this.messagesEl = root.createDiv({ cls: 'claude-mobile-messages' });

    this.contextBarEl = root.createDiv({ cls: 'claude-mobile-context-bar' });
    this.renderContextBar();
    this.registerEvent(this.app.workspace.on('file-open', () => this.renderContextBar()));

    const inputRow = root.createDiv({ cls: 'claude-mobile-input-row' });
    this.inputEl = inputRow.createEl('textarea', {
      cls: 'claude-mobile-input',
      attr: { placeholder: 'Ask Claude… (it can read, search, and edit your notes)', rows: '2' },
    });
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      }
    });
    this.sendBtn = inputRow.createEl('button', { text: 'Send', cls: 'claude-mobile-btn claude-mobile-send' });
    this.sendBtn.onclick = () => (this.running ? this.stop() : this.send());

    if (s.backend === 'api' && !s.apiKey) {
      this.addSystemNotice('No API key configured. Open Settings → Claude Mobile and paste your Anthropic API key.');
    }
    if (s.backend === 'relay' && !s.relayUrl) {
      this.addSystemNotice('No relay URL configured. Open Settings → Claude Mobile and set the Mac relay URL and token.');
    }
  }

  resetChat() {
    if (this.running) this.stop();
    this.messages = [];
    this.sessionId = null;
    this.messagesEl.empty();
    this.context.reset();
    this.renderContextBar();
  }

  /* ------------------------ context bar ------------------------ */

  renderContextBar() {
    if (!this.contextBarEl) return;
    this.contextBarEl.empty();

    const addBtn = this.contextBarEl.createEl('button', {
      text: '+',
      cls: 'claude-mobile-btn claude-mobile-context-add',
      attr: { 'aria-label': 'Add a note to the chat context' },
    });
    addBtn.onclick = () =>
      new ContextFileSuggestModal(
        this.app,
        (path) => {
          this.context.pin(path);
          this.renderContextBar();
        },
        (path) => this.isPathExcluded(path)
      ).open();

    const active = this.app.workspace.getActiveFile();
    if (active && !this.isPathExcluded(active.path)) {
      const off = !this.context.includeActive;
      const pill = this.contextBarEl.createDiv({
        cls: 'claude-mobile-context-pill claude-mobile-context-active' + (off ? ' claude-mobile-context-off' : ''),
      });
      pill.createSpan({ text: '◉ ' + active.basename });
      if (off) {
        pill.setAttr('aria-label', 'Active note excluded — tap to include it again');
        pill.onclick = () => {
          this.context.includeActive = true;
          this.renderContextBar();
        };
      } else {
        const x = pill.createSpan({ text: '×', cls: 'claude-mobile-context-x' });
        x.onclick = () => {
          this.context.includeActive = false;
          this.renderContextBar();
        };
      }
    }

    for (const path of this.context.pinned) {
      if (this.context.includeActive && active && path === active.path) continue; // already shown as active pill
      const pill = this.contextBarEl.createDiv({ cls: 'claude-mobile-context-pill' });
      const name = path.split('/').pop().replace(/\.md$/, '');
      pill.createSpan({ text: name, attr: { title: path } });
      const x = pill.createSpan({ text: '×', cls: 'claude-mobile-context-x' });
      x.onclick = () => {
        this.context.unpin(path);
        this.renderContextBar();
      };
    }
  }

  /** Resolve + read the context set; skips (and unpins) files that no longer exist. */
  async collectContextDocs() {
    const active = this.app.workspace.getActiveFile();
    const activePath = active && !this.isPathExcluded(active.path) ? active.path : null;
    const paths = this.context
      .resolvePaths(activePath)
      .filter((p) => !this.isPathExcluded(p));
    const docs = await readContextDocs(this.app, paths);
    let dropped = false;
    for (const d of docs) {
      if (!d.missing) continue;
      this.addSystemNotice('Context document not found, skipped: ' + d.path);
      this.context.unpin(d.path);
      dropped = true;
    }
    if (dropped) this.renderContextBar();
    return docs.filter((d) => !d.missing);
  }

  addSystemNotice(text) {
    this.messagesEl.createDiv({ cls: 'claude-mobile-notice', text: text });
    this.scrollDown();
  }

  addToolLine(text) {
    this.messagesEl.createDiv({ cls: 'claude-mobile-toolline', text: text });
    this.scrollDown();
  }

  scrollDown() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  setRunning(running) {
    this.running = running;
    this.sendBtn.setText(running ? 'Stop' : 'Send');
    this.sendBtn.toggleClass('claude-mobile-stop', running);
  }

  stop() {
    if (this.abortController) this.abortController.abort();
  }

  async buildSystemPrompt(contextDocs) {
    const s = this.plugin.settings;
    let sys =
      'You are Claude, embedded in the Obsidian app on the user\'s device (possibly a phone or tablet). ' +
      'You have tools to read, search, list, create, and update notes in their vault. ' +
      'Writes (create_note, update_note) require explicit user approval — propose them when useful. ' +
      'Before updating a note, always read it first and return its COMPLETE new content, preserving everything you do not intend to change. ' +
      'Keep responses concise; the user may be on a small screen. ' +
      'Today\'s date: ' + new Date().toISOString().slice(0, 10) + '.';

    sys += buildContextSection(contextDocs || []);

    if (s.includeClaudeMd) {
      const f = this.app.vault.getAbstractFileByPath('CLAUDE.md');
      if (f instanceof TFile) {
        const claudeMd = await this.app.vault.cachedRead(f);
        sys +=
          '\n\n--- VAULT CONVENTIONS (CLAUDE.md) — follow these when reading or writing wiki pages ---\n' +
          claudeMd +
          '\n--- END VAULT CONVENTIONS ---' +
          '\nNote: CLI-only tooling mentioned above (qmd, bash scripts, agents/skills) is NOT available here; ' +
          'use search_vault instead of qmd, and skip index-regeneration scripts (patch index files manually instead).';
      }
    }
    if (s.extraSystemPrompt) sys += '\n\n' + s.extraSystemPrompt;
    return sys;
  }

  async send() {
    const text = this.inputEl.value.trim();
    if (!text || this.running) return;
    if (this.plugin.settings.backend === 'relay') {
      if (!this.plugin.settings.relayUrl) {
        new Notice('Claude Mobile: set the relay URL in settings first.');
        return;
      }
      this.inputEl.value = '';
      return this.sendRelay(text);
    }
    if (!this.plugin.settings.apiKey) {
      new Notice('Claude Mobile: set your API key in settings first.');
      return;
    }
    this.inputEl.value = '';

    const userEl = this.messagesEl.createDiv({ cls: 'claude-mobile-msg claude-mobile-user' });
    userEl.setText(text);
    this.scrollDown();

    this.messages.push({ role: 'user', content: text });
    this.setRunning(true);
    this.abortController = new AbortController();

    try {
      const contextDocs = await this.collectContextDocs();
      const system = await this.buildSystemPrompt(contextDocs);
      let iterations = 0;

      while (iterations < this.plugin.settings.maxToolIterations) {
        iterations++;

        const msgEl = this.messagesEl.createDiv({ cls: 'claude-mobile-msg claude-mobile-assistant' });
        let streamed = '';
        const { blocks } = await callClaude({
          settings: this.plugin.settings,
          system: system,
          messages: this.messages,
          signal: this.abortController.signal,
          onText: (delta) => {
            streamed += delta;
            msgEl.setText(streamed);
            this.scrollDown();
          },
        });

        // Re-render the accumulated text as markdown.
        msgEl.empty();
        const fullText = blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (fullText) {
          await MarkdownRenderer.render(this.app, fullText, msgEl, '', this);
        } else {
          msgEl.remove();
        }
        this.scrollDown();

        this.messages.push({ role: 'assistant', content: blocks });

        const toolUses = blocks.filter((b) => b.type === 'tool_use');
        if (!toolUses.length) break;

        const results = [];
        for (const tu of toolUses) {
          const label =
            tu.name + (tu.input && (tu.input.path || tu.input.query) ? ': ' + (tu.input.path || tu.input.query) : '');
          this.addToolLine('🔧 ' + label);
          const r = await this.tools.execute(tu.name, tu.input || {});
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: r.text,
            is_error: !r.ok,
          });
        }
        this.messages.push({ role: 'user', content: results });
      }

      if (iterations >= this.plugin.settings.maxToolIterations) {
        this.addSystemNotice('Stopped after ' + iterations + ' tool rounds (safety limit).');
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        this.addSystemNotice('Stopped.');
        // Drop trailing state that would corrupt the API history: the last
        // message must not be an assistant message with unanswered tool_use.
        const last = this.messages[this.messages.length - 1];
        if (last && last.role === 'assistant' && Array.isArray(last.content) &&
            last.content.some((b) => b.type === 'tool_use')) {
          this.messages.pop();
        }
      } else {
        this.addSystemNotice('Error: ' + (e && e.message ? e.message : String(e)));
      }
    } finally {
      this.setRunning(false);
      this.abortController = null;
    }
  }

  /* ------------------------ relay backend ------------------------ */

  async sendRelay(text) {
    const s = this.plugin.settings;
    const base = s.relayUrl.replace(/\/+$/, '');

    const userEl = this.messagesEl.createDiv({ cls: 'claude-mobile-msg claude-mobile-user' });
    userEl.setText(text);
    this.scrollDown();

    this.setRunning(true);
    this.abortController = new AbortController();

    try {
      const contextDocs = await this.collectContextDocs();
      const { prompt, sig } = buildRelayPrompt(text, contextDocs, this.context.lastSentSignature);

      const resp = await fetch(base + '/chat', {
        method: 'POST',
        signal: this.abortController.signal,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + s.relayToken,
        },
        body: JSON.stringify({ prompt: prompt, sessionId: this.sessionId }),
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error('Relay error ' + resp.status + ': ' + t.slice(0, 200));
      }
      this.context.lastSentSignature = sig;

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) await this.handleRelayEvent(JSON.parse(line), base);
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        this.addSystemNotice('Stopped.');
      } else {
        this.addSystemNotice(
          'Error: ' + (e && e.message ? e.message : String(e)) +
          (String(e).includes('Failed to fetch') ? ' — is the Mac reachable (Tailscale/Wi-Fi) and the relay running?' : '')
        );
      }
    } finally {
      this.setRunning(false);
      this.abortController = null;
    }
  }

  async handleRelayEvent(ev, base) {
    switch (ev.type) {
      case 'session':
        this.sessionId = ev.id;
        break;
      case 'text': {
        const msgEl = this.messagesEl.createDiv({ cls: 'claude-mobile-msg claude-mobile-assistant' });
        await MarkdownRenderer.render(this.app, ev.text, msgEl, '', this);
        this.scrollDown();
        break;
      }
      case 'tool':
        this.addToolLine('🔧 ' + ev.name + (ev.detail ? ': ' + ev.detail : ''));
        break;
      case 'permission_request': {
        const detail =
          (ev.input && (ev.input.file_path || ev.input.path || ev.input.command)) || '';
        let approved;
        if (this.plugin.settings.autoApprove) {
          approved = true;
          this.addToolLine('⚡ auto-approved: ' + ev.tool + (detail ? ': ' + detail : ''));
        } else {
          const preview =
            ev.input && ev.input.content !== undefined
              ? String(ev.input.content)
              : JSON.stringify(ev.input || {}, null, 2);
          approved = await this.renderApprovalCard({
            title: ev.tool + (detail ? ': ' + detail : ''),
            meta: 'Requested via Mac relay',
            preview: preview,
          });
        }
        // Fire-and-forget is not enough: the relay holds the agent until this arrives.
        await fetch(base + '/approve', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + this.plugin.settings.relayToken,
          },
          body: JSON.stringify({ id: ev.id, approved: approved }),
        }).catch(() => {});
        break;
      }
      case 'result':
        if (ev.sessionId) this.sessionId = ev.sessionId;
        break;
      case 'error':
        this.addSystemNotice('Relay error: ' + ev.message);
        break;
    }
  }

  /* ------------------------ approval cards ------------------------ */

  /** API-backend approval (create_note / update_note from VaultTools). */
  requestApproval(toolName, input) {
    const verb = toolName === 'create_note' ? 'Create' : 'Update';
    if (this.plugin.settings.autoApprove) {
      this.addToolLine('⚡ auto-approved: ' + verb + ' ' + input.path);
      return Promise.resolve(true);
    }
    const meta =
      toolName === 'update_note'
        ? input.oldLength + ' chars → ' + input.content.length + ' chars (full replacement)'
        : input.content.length + ' chars';
    return this.renderApprovalCard({
      title: verb + ' note: ' + input.path,
      meta: meta,
      preview: input.content,
    });
  }

  /** Renders an approval card and resolves true/false on user choice. */
  renderApprovalCard({ title, meta, preview }) {
    return new Promise((resolve) => {
      const card = this.messagesEl.createDiv({ cls: 'claude-mobile-approval' });
      card.createDiv({ cls: 'claude-mobile-approval-title', text: title });
      if (meta) card.createDiv({ cls: 'claude-mobile-approval-meta', text: meta });
      const pre = card.createEl('pre', { cls: 'claude-mobile-approval-preview' });
      pre.setText(preview.length > 3000 ? preview.slice(0, 3000) + '\n[… preview truncated …]' : preview);

      const btnRow = card.createDiv({ cls: 'claude-mobile-approval-btns' });
      const done = (val, label) => {
        btnRow.empty();
        card.createDiv({ cls: 'claude-mobile-approval-meta', text: label });
        resolve(val);
      };
      const approveBtn = btnRow.createEl('button', { text: 'Approve', cls: 'claude-mobile-btn claude-mobile-approve' });
      approveBtn.onclick = () => done(true, '✓ Approved');
      const rejectBtn = btnRow.createEl('button', { text: 'Reject', cls: 'claude-mobile-btn claude-mobile-reject' });
      rejectBtn.onclick = () => done(false, '✗ Rejected');
      this.scrollDown();
    });
  }

  async onClose() {
    if (this.running) this.stop();
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

class ClaudeMobileSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Backend')
      .setDesc(
        'API key: direct Anthropic API (pay per token, works standalone). Mac relay: your Mac runs the Claude Agent SDK on your Claude subscription; the Mac must be on and reachable.'
      )
      .addDropdown((d) =>
        d
          .addOption('api', 'Anthropic API key')
          .addOption('relay', 'Mac relay (Claude subscription)')
          .setValue(this.plugin.settings.backend)
          .onChange(async (v) => {
            this.plugin.settings.backend = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Relay URL')
      .setDesc('Base URL of the Mac relay, e.g. http://100.x.y.z:8814 (Tailscale IP) or http://192.168.x.x:8814 (home LAN).')
      .addText((t) =>
        t.setValue(this.plugin.settings.relayUrl).onChange(async (v) => {
          this.plugin.settings.relayUrl = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Relay token')
      .setDesc('Shared secret from ~/claude-relay/config.json on your Mac. Stored on this device only (not synced) — enter it once per device.')
      .addText((t) => {
        t.setValue(this.plugin.settings.relayToken).onChange(async (v) => {
          this.plugin.settings.relayToken = v.trim();
          await this.plugin.saveSettings();
        });
        t.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('Anthropic API key')
      .setDesc(
        'From platform.anthropic.com. Stored on this device only (not synced) — enter it once per device.'
      )
      .addText((t) => {
        t.setPlaceholder('sk-ant-…')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
          });
        t.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('Model')
      .setDesc('Anthropic model ID.')
      .addText((t) =>
        t.setValue(this.plugin.settings.model).onChange(async (v) => {
          this.plugin.settings.model = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Max output tokens')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxTokens)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.maxTokens = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName('Include CLAUDE.md as vault conventions')
      .setDesc('Loads CLAUDE.md from the vault root into the system prompt (MyRAG wiki conventions).')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.includeClaudeMd).onChange(async (v) => {
          this.plugin.settings.includeClaudeMd = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Extra system prompt')
      .setDesc('Optional additional instructions appended to the system prompt.')
      .addTextArea((t) =>
        t.setValue(this.plugin.settings.extraSystemPrompt).onChange(async (v) => {
          this.plugin.settings.extraSystemPrompt = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Private folders (hidden from Claude)')
      .setDesc(
        'One vault path per line (or comma-separated). Everything under these paths is invisible to Claude: excluded from reading, search, folder listings, writes, and the context bar. Note: applies to the API backend and this plugin\'s UI — the Mac relay reads files via the Agent SDK and does not enforce this list.'
      )
      .addTextArea((t) =>
        t
          .setPlaceholder('private\njournals/therapy')
          .setValue(this.plugin.settings.excludedFolders)
          .onChange(async (v) => {
            this.plugin.settings.excludedFolders = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Respect Obsidian\'s "Excluded files"')
      .setDesc('Also hide everything matched by Options → Files and links → Excluded files.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.respectObsidianExcludes).onChange(async (v) => {
          this.plugin.settings.respectObsidianExcludes = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Auto-approve all actions ("YOLO" mode)')
      .setDesc(
        '⚠️ Skips every approval card. Claude can then create and overwrite notes without asking — and via the Mac relay also run Bash commands on your Mac. Auto-approved actions are still listed in the chat. This setting syncs to all your devices via data.json.'
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoApprove).onChange(async (v) => {
          this.plugin.settings.autoApprove = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Max tool rounds per message')
      .setDesc('Safety limit on agentic loops.')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxToolIterations)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.maxToolIterations = n;
            await this.plugin.saveSettings();
          }
        })
      );
  }
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class ClaudeMobilePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new ClaudeMobileView(leaf, this));

    this.addRibbonIcon('bot-message-square', 'Open Claude', () => this.activateView());
    this.addCommand({
      id: 'open-claude-mobile',
      name: 'Open Claude chat',
      callback: () => this.activateView(),
    });

    this.addSettingTab(new ClaudeMobileSettingTab(this.app, this));
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /**
   * Secrets (API key, relay token) are stored per-device via Obsidian's
   * localStorage — outside the vault, so they never sync through iCloud.
   * data.json carries only non-secret settings. Legacy secrets found in
   * data.json are migrated to local storage and removed.
   */
  async loadSettings() {
    const data = (await this.loadData()) || {};
    let migrated = false;
    for (const k of SECRET_KEYS) {
      if (data[k]) {
        if (!this.app.loadLocalStorage(LS_PREFIX + k)) {
          this.app.saveLocalStorage(LS_PREFIX + k, data[k]);
        }
        delete data[k];
        migrated = true;
      }
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    for (const k of SECRET_KEYS) {
      this.settings[k] = this.app.loadLocalStorage(LS_PREFIX + k) || '';
    }
    if (migrated) await this.saveData(this.stripSecrets());
  }

  stripSecrets() {
    const clean = Object.assign({}, this.settings);
    for (const k of SECRET_KEYS) delete clean[k];
    return clean;
  }

  async saveSettings() {
    for (const k of SECRET_KEYS) {
      this.app.saveLocalStorage(LS_PREFIX + k, this.settings[k] || null);
    }
    await this.saveData(this.stripSecrets());
  }

  onunload() {}
}

module.exports = ClaudeMobilePlugin;

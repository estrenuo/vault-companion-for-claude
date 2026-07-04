/*
 * Claude Relay — exposes the Claude Agent SDK (authenticated with your Claude
 * subscription via Claude Code) as a small HTTP service for the Claude Mobile
 * Obsidian plugin.
 *
 * Endpoints (all except /health require "Authorization: Bearer <token>"):
 *   GET  /health            → { ok }
 *   POST /chat              → NDJSON stream. Body: { prompt, sessionId?, model? }
 *   POST /approve           → Body: { id, approved }  (answers a permission_request)
 *
 * NDJSON event lines sent by /chat:
 *   { type:"session", id }
 *   { type:"text", text }
 *   { type:"tool", name, detail }
 *   { type:"permission_request", id, tool, input }
 *   { type:"result", sessionId }
 *   { type:"error", message }
 *
 * Config: ./config.json → { token, vaultPath, port, defaultModel }
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

const PORT = config.port || 8814;
const VAULT = config.vaultPath;
const TOKEN = config.token;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

// Tools that never need phone approval (read-only / bookkeeping).
const AUTO_ALLOWED = ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task'];

if (!TOKEN || !VAULT) {
  console.error('config.json must define "token" and "vaultPath"');
  process.exit(1);
}

/** pending permission requests: id → { resolve, timer } */
const pendingApprovals = new Map();
const MAX_CONCURRENT_CHATS = 5;
let activeChats = 0;

function authorized(req) {
  const h = req.headers['authorization'] || '';
  const got = Buffer.from(h.replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function toolDetail(name, input) {
  if (!input) return '';
  return (
    input.file_path || input.path || input.pattern || input.query || input.command || input.url || ''
  );
}

async function handleChat(req, res) {
  if (activeChats >= MAX_CONCURRENT_CHATS) {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'too many concurrent chats (max ' + MAX_CONCURRENT_CHATS + ')' }));
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    res.writeHead(400);
    res.end('bad json');
    return;
  }
  if (!body.prompt) {
    res.writeHead(400);
    res.end('missing prompt');
    return;
  }

  activeChats++;
  /** approval ids owned by THIS chat — so ending one chat never cancels another chat's approvals */
  const myApprovals = new Set();
  const abort = new AbortController();
  res.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
  });
  const send = (obj) => {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
  };

  const failMyApprovals = (reason) => {
    for (const id of myApprovals) {
      const p = pendingApprovals.get(id);
      if (p) p.resolve(false, reason);
    }
    myApprovals.clear();
  };

  req.on('close', () => {
    if (!res.writableEnded) {
      abort.abort();
      failMyApprovals('client disconnected');
    }
  });

  const canUseTool = (toolName, input) =>
    new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pendingApprovals.delete(id);
        myApprovals.delete(id);
        resolve({ behavior: 'deny', message: 'Approval timed out on the user device.' });
      }, APPROVAL_TIMEOUT_MS);
      myApprovals.add(id);
      pendingApprovals.set(id, {
        resolve: (approved, reason) => {
          clearTimeout(timer);
          pendingApprovals.delete(id);
          myApprovals.delete(id);
          resolve(
            approved
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: reason || 'User rejected this action from their device.' }
          );
        },
      });
      send({ type: 'permission_request', id: id, tool: toolName, input: input });
    });

  try {
    const q = query({
      prompt: (async function* () {
        yield { type: 'user', message: { role: 'user', content: body.prompt } };
      })(),
      options: {
        cwd: VAULT,
        resume: body.sessionId || undefined,
        model: body.model || config.defaultModel || undefined,
        settingSources: ['project'], // loads the vault's CLAUDE.md
        allowedTools: AUTO_ALLOWED,
        canUseTool: canUseTool,
        abortController: abort,
      },
    });

    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        send({ type: 'session', id: msg.session_id });
      } else if (msg.type === 'assistant') {
        const content = (msg.message && msg.message.content) || [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            send({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            send({ type: 'tool', name: block.name, detail: toolDetail(block.name, block.input) });
          }
        }
      } else if (msg.type === 'result') {
        send({ type: 'result', sessionId: msg.session_id });
      }
    }
  } catch (e) {
    if (!abort.signal.aborted) {
      send({ type: 'error', message: e && e.message ? e.message : String(e) });
      console.error('chat error:', e);
    }
  } finally {
    activeChats--;
    failMyApprovals('chat ended');
    if (!res.writableEnded) res.end();
  }
}

async function handleApprove(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    res.writeHead(400);
    res.end('bad json');
    return;
  }
  const p = pendingApprovals.get(body.id);
  if (!p) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown or expired approval id' }));
    return;
  }
  p.resolve(!!body.approved);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

const server = createServer(async (req, res) => {
  // Minimal CORS for the Obsidian webview (capacitor:// / app:// origins).
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && req.url === '/health') {
      // Unauthenticated: reveal nothing beyond liveness.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/chat') return void (await handleChat(req, res));
    if (req.method === 'POST' && req.url === '/approve') return void (await handleApprove(req, res));
    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    console.error('request error:', e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Claude Relay listening on port ' + PORT + ', vault: ' + VAULT);
});

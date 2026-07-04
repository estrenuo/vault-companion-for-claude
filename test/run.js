/*
 * Unit tests for the plugin's testable core: SSE parsing, vault tools,
 * approval contract, and per-device secret handling.
 * Run from the repo root: node test/run.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Module = require('module');

// Route require('obsidian') to the stub.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'obsidian') return path.join(__dirname, 'obsidian-stub.js');
  return origResolve.call(this, request, ...args);
};

// Load main.js with its module-private internals exposed for testing.
const src =
  fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8') +
  '\nmodule.exports.__test = { parseSseStream, VaultTools };';
const tmp = path.join(os.tmpdir(), 'vcfc-main-test-' + Date.now() + '.js');
fs.writeFileSync(tmp, src);
const PluginClass = require(tmp);
const { parseSseStream, VaultTools } = PluginClass.__test;
const { TFile } = require('obsidian');

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('  ok  ' + name);
  } catch (e) {
    failures++;
    console.error('FAIL  ' + name + '\n      ' + e.message);
  }
}

/* ---------------- fixtures ---------------- */

function sseFixture() {
  const events = [
    { type: 'message_start' },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'read_note', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'th":"index.md"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
  return events.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');
}

function chunkedResponse(sse, chunkSize) {
  const chunks = [];
  for (let i = 0; i < sse.length; i += chunkSize) chunks.push(sse.slice(i, i + chunkSize));
  const enc = new TextEncoder();
  let ci = 0;
  return {
    body: {
      getReader: () => ({
        read: async () =>
          ci < chunks.length ? { done: false, value: enc.encode(chunks[ci++]) } : { done: true },
      }),
    },
  };
}

function fakeApp(files) {
  class FTFile {
    constructor(p) {
      this.path = p;
      this.stat = { size: (files[p] || '').length };
    }
  }
  Object.setPrototypeOf(FTFile.prototype, TFile.prototype);
  return {
    app: {
      vault: {
        getAbstractFileByPath: (p) => (files[p] !== undefined ? new FTFile(p) : null),
        cachedRead: async (f) => files[f.path],
        getMarkdownFiles: () => Object.keys(files).map((p) => new FTFile(p)),
        create: async (p, c) => {
          files[p] = c;
        },
        modify: async (f, c) => {
          files[f.path] = c;
        },
        createFolder: async () => {},
        getRoot: () => null,
      },
      workspace: { getActiveFile: () => new FTFile('index.md') },
    },
  };
}

/* ---------------- tests ---------------- */

(async () => {
  await test('SSE: text streaming across awkward chunk boundaries', async () => {
    let streamed = '';
    const r = await parseSseStream(chunkedResponse(sseFixture(), 17), (d) => (streamed += d));
    assert.strictEqual(streamed, 'Hello world');
    assert.strictEqual(r.stopReason, 'tool_use');
    assert.strictEqual(r.blocks[0].text, 'Hello world');
  });

  await test('SSE: tool_use input assembled from partial JSON deltas', async () => {
    const r = await parseSseStream(chunkedResponse(sseFixture(), 5), () => {});
    const tu = r.blocks.find((b) => b.type === 'tool_use');
    assert.strictEqual(tu.id, 'tu_1');
    assert.deepStrictEqual(tu.input, { path: 'index.md' });
  });

  await test('SSE: fallback path without ReadableStream', async () => {
    const r = await parseSseStream({ text: async () => sseFixture() }, () => {});
    assert.strictEqual(r.blocks.find((b) => b.type === 'tool_use').input.path, 'index.md');
  });

  await test('VaultTools: read, search, active note', async () => {
    const files = { 'index.md': '# Index\nhello data vault content', 'wiki/a.md': 'nothing' };
    const { app } = fakeApp(files);
    const vt = new VaultTools(app, async () => true);
    assert.ok((await vt.execute('read_note', { path: 'index.md' })).text.includes('data vault'));
    const s = await vt.execute('search_vault', { query: 'data vault' });
    assert.ok(s.ok && s.text.includes('index.md') && !s.text.includes('wiki/a.md'));
    const a = await vt.execute('get_active_note', {});
    assert.ok(a.ok && a.text.includes('Active note: index.md'));
  });

  await test('VaultTools: approval gates writes; rejection prevents them', async () => {
    const files = { 'x.md': 'old' };
    const { app } = fakeApp(files);
    const approve = new VaultTools(app, async () => true);
    const reject = new VaultTools(app, async () => false);
    assert.ok((await approve.execute('update_note', { path: 'x.md', content: 'new' })).ok);
    assert.strictEqual(files['x.md'], 'new');
    const r = await reject.execute('create_note', { path: 'y.md', content: 'z' });
    assert.ok(!r.ok && files['y.md'] === undefined);
  });

  await test('Secrets: migrate out of data.json, never write back', async () => {
    const local = {};
    let saved = null;
    const p = new PluginClass();
    p.app = {
      loadLocalStorage: (k) => local[k] ?? null,
      saveLocalStorage: (k, v) => {
        if (v === null) delete local[k];
        else local[k] = v;
      },
    };
    p.loadData = async () => ({ backend: 'relay', apiKey: 'sk-legacy', relayToken: 'tok' });
    p.saveData = async (d) => (saved = d);

    await p.loadSettings();
    assert.strictEqual(local['claude-mobile:apiKey'], 'sk-legacy');
    assert.ok(!('apiKey' in saved) && !('relayToken' in saved));
    assert.strictEqual(p.settings.apiKey, 'sk-legacy');

    p.settings.apiKey = 'sk-new';
    await p.saveSettings();
    assert.ok(!('apiKey' in saved));
    assert.strictEqual(local['claude-mobile:apiKey'], 'sk-new');

    p.settings.relayToken = '';
    await p.saveSettings();
    assert.ok(!('claude-mobile:relayToken' in local));
  });

  fs.unlinkSync(tmp);
  if (failures) {
    console.error(failures + ' test(s) failed');
    process.exit(1);
  }
  console.log('All tests passed.');
})();

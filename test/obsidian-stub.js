/* Minimal stub of the 'obsidian' module for unit tests (Node, no Obsidian). */
'use strict';

class Plugin {}
class ItemView {}
class PluginSettingTab {}
class Setting {}
class Notice {}
class TFile {}
class TFolder {}

module.exports = {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  TFolder,
  MarkdownRenderer: { render: async () => {} },
  normalizePath: (p) => p.replace(/^\/+/, ''),
  requestUrl: async () => ({ status: 500, text: 'stub', json: null }),
};

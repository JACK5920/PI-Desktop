'use strict';

const store = require('./lib/store.js');
const recall = require('./lib/recall.js');
const { looksLikeSecret, looksLikeInstruction } = require('./lib/text.js');

const TOOLS = ['memory_remember', 'memory_recall', 'memory_forget', 'memory_purge', 'memory_status'];
const COMMANDS = ['pi-memory.open', 'pi-memory.reindex'];

let settings = {};
let onTurnEnded = null;
let onSettingsChanged = null;
let startupIssue = null;

const DEFAULT_SETTINGS = {
  tier1BudgetChars: 6000, autoInject: true, progressDecayDays: 7, contextDecayDays: 30,
  profile: '', userMemory: [], globalEntries: [], autoCaptureMemory: true,
};

async function loadSettings() {
  // Host settings may omit manifest defaults; never let a missing key zero the budget or the global layers.
  try {
    const raw = await pi.plugin.getSettings();
    return Object.assign({}, DEFAULT_SETTINGS, raw && typeof raw === 'object' ? raw : {});
  } catch (err) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

function safeContext(context) {
  return {
    sessionId: context && typeof context.sessionId === 'string' ? context.sessionId : undefined,
    turnId: context && typeof context.turnId === 'string' ? context.turnId : undefined,
  };
}

async function currentWorkspace() {
  if (!pi.workspace || typeof pi.workspace.get !== 'function') return null;
  return pi.workspace.get();
}

async function readProjectEntries() {
  return await currentWorkspace() ? store.readAll() : [];
}

async function rebuildIfWorkspace() {
  return await currentWorkspace() ? store.rebuild(settings) : { skipped: true, reason: 'no-workspace' };
}

async function toolRemember(args, context) {
  const input = args && typeof args === 'object' ? args : {};
  if (input.scope === 'global') return rememberGlobal(input, safeContext(context));
  if (!await currentWorkspace()) {
    throw Object.assign(new Error('Project/session memory requires an open project. Use global scope for cross-project facts.'), { code: 'NO_PROJECT_WORKSPACE' });
  }
  if (input.scope === 'session' && !(context && typeof context.sessionId === 'string' && context.sessionId)) {
    throw Object.assign(new Error('Session memory requires an active session id.'), { code: 'INVALID_ARGUMENT' });
  }
  return store.append(input, settings, safeContext(context));
}

async function toolRecall(args, context) {
  const input = args && typeof args === 'object' ? args : {};
  return recall.search(input, settings, safeContext(context), [...await readProjectEntries(), ...getGlobalEntries()]);
}

async function toolForget(args) {
  const input = args && typeof args === 'object' ? args : {};
  if (getGlobalEntries().some((entry) => entry.id === input.id)) return retireGlobal(input.id, input.reason);
  return store.retire(input.id, input.reason, settings);
}

function getGlobalEntries() {
  return Array.isArray(settings.globalEntries) ? settings.globalEntries : [];
}

async function persistGlobalEntries(entries, options = {}) {
  await pi.plugin.setSettings(Object.assign({}, settings, { globalEntries: entries }));
  settings = await loadSettings();
  if (await currentWorkspace()) await store.rebuild(settings, { permanentPurge: options.permanentPurge === true });
}

async function rememberGlobal(input, context) {
  const clean = store.validateInput(input);
  const entries = [...getGlobalEntries()];
  const clash = entries.find((entry) => !entry.supersededBy && entry.type === clean.type && entry.key === clean.key);
  const now = Date.now();
  if (clash) {
    if (clash.content !== clean.content) {
      clash.history = Array.isArray(clash.history) ? clash.history : [];
      clash.history.push({ content: clash.content, at: clash.updatedAt || clash.createdAt || now });
    }
    clash.content = clean.content;
    clash.updatedAt = now;
    clash.confidence = Math.min(1, (Number(clash.confidence) || 0.5) + 0.1);
    clash.tags = clean.tags;
    clash.quarantined = looksLikeInstruction(clean.content);
    await persistGlobalEntries(entries);
    return { id: clash.id, action: 'updated', scope: 'global', quarantined: clash.quarantined };
  }
  if (entries.length >= 200) {
    throw Object.assign(new Error('global memory reached its 200-entry limit; permanently remove stale entries first'), { code: 'MEMORY_GLOBAL_LIMIT' });
  }
  const entry = {
    id: store.newId(), schema: 1, type: clean.type, scope: 'global', key: clean.key, content: clean.content,
    tags: clean.tags, trust: clean.trust, confidence: clean.trust === 'user-explicit' ? 1 : clean.trust === 'agent-extracted' ? 0.7 : 0.5,
    createdAt: now, updatedAt: now, lastAccessedAt: now, accessCount: 0,
    supersedes: null, supersededBy: null, contradicts: [], quarantined: looksLikeInstruction(clean.content),
    source: context && context.sessionId ? { kind: 'tool', sessionId: context.sessionId, turnId: context.turnId } : { kind: 'panel' },
    expiresAt: null,
  };
  const conflict = entries.find((existing) => !existing.supersededBy && existing.key === clean.key && existing.content !== clean.content);
  if (conflict) {
    entry.contradicts = [conflict.id];
    conflict.contradicts = Array.from(new Set([...(conflict.contradicts || []), entry.id]));
  }
  entries.push(entry);
  await persistGlobalEntries(entries);
  return { id: entry.id, action: entry.quarantined ? 'quarantined' : 'created', scope: 'global', quarantined: entry.quarantined };
}

async function retireGlobal(id, reason) {
  const entries = [...getGlobalEntries()];
  const target = entries.find((entry) => entry.id === id);
  if (!target) throw Object.assign(new Error('global memory not found'), { code: 'NOT_FOUND' });
  target.supersededBy = `retired:${Date.now().toString(36)}`;
  target.updatedAt = Date.now();
  if (reason) target.retireReason = String(reason).slice(0, 200);
  await persistGlobalEntries(entries);
  return { id, action: 'retired', scope: 'global' };
}

async function updateGlobal(id, content) {
  const text = typeof content === 'string' ? content.trim().slice(0, 2000) : '';
  if (!text || looksLikeSecret(text)) throw Object.assign(new Error('invalid or credential-like global memory'), { code: 'INVALID_ARGUMENT' });
  const entries = [...getGlobalEntries()];
  const target = entries.find((entry) => entry.id === id && !entry.supersededBy);
  if (!target) throw Object.assign(new Error('global memory not found'), { code: 'NOT_FOUND' });
  target.history = Array.isArray(target.history) ? target.history : [];
  target.history.push({ content: target.content, at: target.updatedAt || target.createdAt || Date.now() });
  target.content = text;
  target.updatedAt = Date.now();
  target.quarantined = looksLikeInstruction(text);
  await persistGlobalEntries(entries);
  return { id, action: 'updated', scope: 'global', quarantined: target.quarantined };
}

async function purgeGlobal(id) {
  const entries = getGlobalEntries();
  const next = entries.filter((entry) => entry.id !== id);
  if (next.length === entries.length) return null;
  await persistGlobalEntries(next, { permanentPurge: true });
  return { id, action: 'purged', scope: 'global' };
}

async function migrateWorkspaceGlobalEntries() {
  if (!await currentWorkspace()) return;
  const workspaceEntries = await store.readAll();
  const legacyGlobal = workspaceEntries.filter((entry) => entry.scope === 'global');
  if (!legacyGlobal.length) return;
  const current = getGlobalEntries();
  const ids = new Set(current.map((entry) => entry.id));
  const merged = [...current, ...legacyGlobal.filter((entry) => !ids.has(entry.id))];
  if (merged.length > 200) throw Object.assign(new Error('cannot migrate workspace-global memories: global store is full'), { code: 'MEMORY_GLOBAL_LIMIT' });
  await pi.plugin.setSettings(Object.assign({}, settings, { globalEntries: merged }));
  settings = await loadSettings();
  await store.removeByScope('global', settings);
}

function validateImportedGlobalEntries(rawEntries) {
  if (rawEntries === undefined) return getGlobalEntries();
  if (!Array.isArray(rawEntries) || rawEntries.length > 200) {
    throw Object.assign(new Error('global memory import must be an array of at most 200 entries'), { code: 'INVALID_ARGUMENT' });
  }
  const entries = [...getGlobalEntries()];
  const ids = new Set(entries.map((entry) => entry.id));
  const keys = new Set(entries.filter((entry) => !entry.supersededBy).map((entry) => `${entry.type}:${entry.key}`));
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 200
      || typeof raw.content !== 'string' || raw.content.length > 2000) {
      throw Object.assign(new Error('invalid global memory import entry'), { code: 'INVALID_ARGUMENT' });
    }
    if (ids.has(raw.id)) continue;
    const clean = store.validateInput({
      type: raw.type, key: raw.key, content: raw.content, tags: raw.tags, trust: raw.trust, scope: 'global',
    });
    const key = `${clean.type}:${clean.key}`;
    if (keys.has(key)) continue;
    const now = Date.now();
    const confidence = Number(raw.confidence);
    entries.push({
      id: raw.id, schema: 1, type: clean.type, scope: 'global', key: clean.key, content: clean.content,
      tags: clean.tags, trust: clean.trust,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
      createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : now,
      updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : now,
      lastAccessedAt: Number.isFinite(Number(raw.lastAccessedAt)) ? Number(raw.lastAccessedAt) : now,
      accessCount: Number.isFinite(Number(raw.accessCount)) ? Math.max(0, Math.trunc(Number(raw.accessCount))) : 0,
      supersededBy: typeof raw.supersededBy === 'string' ? raw.supersededBy : null,
      quarantined: Boolean(raw.quarantined) || looksLikeInstruction(clean.content),
      source: { kind: 'import' }, expiresAt: null,
    });
    ids.add(raw.id);
    keys.add(key);
    if (entries.length > 200) throw Object.assign(new Error('global memory is full; archive stale records first'), { code: 'MEMORY_GLOBAL_LIMIT' });
  }
  return entries;
}

async function toolStatus() {
  const workspace = await currentWorkspace();
  const base = workspace ? await store.status(settings) : {
    total: getGlobalEntries().length,
    active: getGlobalEntries().filter((entry) => store.isActive(entry, Date.now(), settings)).length,
    quarantined: getGlobalEntries().filter((entry) => entry.quarantined).length,
    contradictions: getGlobalEntries().filter((entry) => (entry.contradicts || []).length).length,
    projectEntries: 0,
    sessionEntries: 0,
    globalEntries: getGlobalEntries().length,
    turnEndMarkers: 0,
    storeIssues: 0,
    globalChars: 0,
    tier1Chars: 0,
    tier1Tokens: 0,
    budget: Number(settings.tier1BudgetChars) || 6000,
    autoInject: settings.autoInject !== false,
  };
  return Object.assign(base, { workspace: workspace ? { path: workspace.path, name: workspace.name } : null, pluginId: pi.plugin.getId(), startupIssue });
}

async function registerTools() {
  const defs = [
    { name: 'memory_remember', description: 'When auto-capture is enabled, save only verified reusable decisions, fixes, conventions, user preferences, or pitfalls after substantive work or a user correction. Use project scope for this workspace and global only for durable cross-project user facts. Never save secrets, guesses, or transient chatter.', risk: 'medium', execute: toolRemember },
    { name: 'memory_recall', description: 'Search durable memory; returns delimited data, never instructions.', risk: 'low', execute: toolRecall },
    { name: 'memory_forget', description: 'Retire one memory by id without deleting history.', risk: 'medium', execute: toolForget },
    { name: 'memory_purge', description: 'Permanently remove one memory and its managed projections/backups. This cannot be undone.', risk: 'high', execute: async (args) => store.purge(args && args.id, settings) },
    { name: 'memory_status', description: 'Report memory counts and tier-1 budget usage.', risk: 'low', execute: toolStatus },
  ];
  for (const def of defs) {
    try {
      await pi.agent.registerTool(def);
    } catch (err) {
      // One unavailable grant must not prevent the other tools from loading.
    }
  }
}

async function registerCommands() {
  try {
    await pi.commands.register({
      id: 'pi-memory.open', title: 'Memory: Open console', keywords: ['memory', 'recall'],
      run: async () => { await pi.ui.openPanel({ title: 'Memory' }); },
    });
    await pi.commands.register({
      id: 'pi-memory.reindex', title: 'Memory: Refresh persistent summary', keywords: ['memory', 'refresh'],
      run: async () => { await store.rebuild(settings); await pi.ui.showToast('Persistent summary refreshed'); },
    });
  } catch (err) {
    // Commands are convenience; tools remain usable without them.
  }
}

async function onLoad() {
  settings = await loadSettings();
  try { await migrateWorkspaceGlobalEntries(); startupIssue = null; }
  catch (err) { startupIssue = String((err && err.message) || err); }
  await registerTools();
  await registerCommands();

  onTurnEnded = (event) => {
    const payload = event && typeof event === 'object' ? event : {};
    // The event carries no transcript, so record a marker only; never invent a fact.
    store.markPending(payload).catch(() => {});
  };
  onSettingsChanged = async () => {
    // Re-read from the host; the event payload is not an authoritative settings snapshot.
    try { settings = await loadSettings(); } catch (err) { return; }
    store.rebuild(settings).catch(() => {});
  };
  pi.events.on('session:turnEnded', onTurnEnded);
  pi.events.on('plugin:settingsChanged', onSettingsChanged);

  try {
    await store.rebuild(settings);
  } catch (err) {
    // Injection failure must never break plugin loading.
  }
}

async function onUnload() {
  if (onTurnEnded) pi.events.off('session:turnEnded', onTurnEnded);
  if (onSettingsChanged) pi.events.off('plugin:settingsChanged', onSettingsChanged);
  for (const name of TOOLS) {
    try { await pi.agent.unregisterTool(name); } catch (err) { /* best effort */ }
  }
  for (const id of COMMANDS) {
    try { await pi.commands.unregister(id); } catch (err) { /* best effort */ }
  }
}

async function onPanelInvoke(channel, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  switch (channel) {
    case 'memory.list': return { entries: [...await readProjectEntries(), ...getGlobalEntries()].filter((e) => !e.supersededBy && !e.quarantined).slice(-200).reverse() };
    case 'memory.quarantine.list': return { entries: [...await readProjectEntries(), ...getGlobalEntries()].filter((e) => !e.supersededBy && e.quarantined).slice(-200).reverse() };
    case 'memory.search': {
      const all = [...await readProjectEntries(), ...getGlobalEntries()];
      const found = await recall.search({ query: String(input.query || ''), limit: 20 }, settings, { includeAllSessions: true }, all);
      return { entries: all.filter((e) => found.ids.includes(e.id)) };
    }
    case 'memory.status': return toolStatus();
    case 'memory.settings.get': return {
      workspace: await currentWorkspace(),
      settings: {
        autoCaptureMemory: settings.autoCaptureMemory !== false,
        autoInject: settings.autoInject !== false,
        tier1BudgetChars: settings.tier1BudgetChars,
        progressDecayDays: settings.progressDecayDays,
        contextDecayDays: settings.contextDecayDays,
      },
    };
    case 'memory.settings.set': {
      const next = { ...settings };
      if (Object.hasOwn(input, 'autoCaptureMemory')) next.autoCaptureMemory = Boolean(input.autoCaptureMemory);
      if (Object.hasOwn(input, 'autoInject')) next.autoInject = Boolean(input.autoInject);
      for (const key of ['tier1BudgetChars', 'progressDecayDays', 'contextDecayDays']) {
        if (!Object.hasOwn(input, key)) continue;
        const value = Number(input[key]);
        const min = key === 'tier1BudgetChars' ? 1000 : 1;
        const max = key === 'tier1BudgetChars' ? 24000 : 365;
        if (!Number.isFinite(value) || value < min || value > max) {
          throw Object.assign(new Error(`${key} must be between ${min} and ${max}`), { code: 'INVALID_ARGUMENT' });
        }
        next[key] = Math.trunc(value);
      }
      await pi.plugin.setSettings(next);
      settings = await loadSettings();
      await rebuildIfWorkspace();
      return { ok: true, settings: {
        autoCaptureMemory: settings.autoCaptureMemory !== false,
        autoInject: settings.autoInject !== false,
        tier1BudgetChars: settings.tier1BudgetChars,
        progressDecayDays: settings.progressDecayDays,
        contextDecayDays: settings.contextDecayDays,
      } };
    }
    case 'memory.user.get': return { profile: settings.profile || '', userMemory: Array.isArray(settings.userMemory) ? settings.userMemory : [] };
    case 'memory.user.set': {
      const profile = typeof input.profile === 'string' ? input.profile.slice(0, 1500) : (settings.profile || '');
      const userMemory = Array.isArray(input.userMemory) ? input.userMemory.filter((x) => typeof x === 'string').slice(0, 20) : [];
      if (looksLikeSecret(profile) || userMemory.some((line) => line.length > 400 || looksLikeSecret(line))) {
        throw Object.assign(new Error('全局记忆包含疑似凭据或超出长度限制'), { code: 'INVALID_ARGUMENT' });
      }
      await pi.plugin.setSettings(Object.assign({}, settings, { profile, userMemory }));
      settings = await loadSettings();
      await rebuildIfWorkspace();
      return { ok: true };
    }
    case 'memory.update': return getGlobalEntries().some((entry) => entry.id === input.id)
      ? updateGlobal(input.id, input.content) : store.update(input.id, input.content, settings);
    case 'memory.retire': return getGlobalEntries().some((entry) => entry.id === input.id)
      ? retireGlobal(input.id, 'panel') : store.retire(input.id, 'panel', settings);
    case 'memory.purge': return (await purgeGlobal(input.id)) || store.purge(input.id, settings);
    case 'memory.rebuild': return { tier1: await rebuildIfWorkspace() };
    case 'memory.export': {
      const exported = await currentWorkspace() ? await store.exportAll(settings) : {
        schema: 1, exportedAt: Date.now(), entries: [],
        userSettings: { profile: settings.profile || '', userMemory: Array.isArray(settings.userMemory) ? settings.userMemory : [] },
      };
      exported.userSettings.globalEntries = getGlobalEntries();
      return exported;
    }
    case 'memory.import': {
      const incomingSettings = input.payload && input.payload.userSettings && typeof input.payload.userSettings === 'object'
        ? input.payload.userSettings : {};
      if (Object.prototype.hasOwnProperty.call(incomingSettings, 'globalEntries') && !Array.isArray(incomingSettings.globalEntries)) {
        throw Object.assign(new Error('globalEntries must be an array'), { code: 'INVALID_ARGUMENT' });
      }
      const allEntries = input.payload && Array.isArray(input.payload.entries) ? input.payload.entries : [];
      const previousGlobalCount = getGlobalEntries().length;
      const importedGlobal = validateImportedGlobalEntries([
        ...(Array.isArray(incomingSettings.globalEntries) ? incomingSettings.globalEntries : []),
        ...allEntries.filter((entry) => entry && entry.scope === 'global'),
      ]);
      const importPayload = Object.assign({}, input.payload, {
        entries: allEntries.filter((entry) => !entry || entry.scope !== 'global'),
        userSettings: Object.assign({}, incomingSettings, {
          profile: typeof incomingSettings.profile === 'string' ? incomingSettings.profile : settings.profile || '',
          userMemory: Array.isArray(incomingSettings.userMemory) ? incomingSettings.userMemory : settings.userMemory || [],
        }),
      });
      const workspace = await currentWorkspace();
      if (!workspace && importPayload.entries.length > 0) {
        throw Object.assign(new Error('This import contains project memories. Open the matching project before importing them.'), { code: 'NO_PROJECT_WORKSPACE' });
      }
      if (!workspace) {
        const profile = typeof incomingSettings.profile === 'string' && incomingSettings.profile.length <= 1500
          ? incomingSettings.profile : settings.profile || '';
        const userMemory = Array.isArray(incomingSettings.userMemory)
          ? incomingSettings.userMemory.filter((x) => typeof x === 'string' && x.length <= 400).slice(0, 20) : settings.userMemory || [];
        await pi.plugin.setSettings(Object.assign({}, settings, { profile, userMemory, globalEntries: importedGlobal }));
        settings = await loadSettings();
        return { imported: Math.max(0, importedGlobal.length - previousGlobalCount), total: importedGlobal.length, settingsImported: true };
      }
      const result = await store.importAll(importPayload, settings);
      if (result.userSettings) {
        const profile = typeof result.userSettings.profile === 'string' && result.userSettings.profile.length <= 1500
          ? result.userSettings.profile : settings.profile || '';
        const userMemory = Array.isArray(result.userSettings.userMemory)
          ? result.userSettings.userMemory.filter((x) => typeof x === 'string' && x.length <= 400).slice(0, 20) : (settings.userMemory || []);
        await pi.plugin.setSettings(Object.assign({}, settings, { profile, userMemory, globalEntries: importedGlobal }));
        settings = await loadSettings();
        await store.rebuild(settings);
        delete result.userSettings;
        result.settingsImported = true;
        result.imported += Math.max(0, importedGlobal.length - previousGlobalCount);
      }
      return result;
    }
    default: throw Object.assign(new Error(`unknown channel: ${channel}`), { code: 'UNSUPPORTED' });
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };

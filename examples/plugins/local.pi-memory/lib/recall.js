'use strict';

const { normalize, tokens, jaccard, wrapAsData } = require('./text.js');
const store = require('./store.js');

const WEIGHTS = { keyword: 0.42, tag: 0.14, exact: 0.12, fresh: 0.10, confidence: 0.12, access: 0.10 };

function clampLimit(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(20, Math.max(1, Math.trunc(n))) : 8;
}

function scopeMatch(entry, requested, context = {}) {
  const sessionId = context.sessionId;
  if (requested === 'all' || !requested) {
    return !String(entry.scope || '').startsWith('session:') || context.includeAllSessions === true || entry.scope === `session:${sessionId || 'unknown'}`;
  }
  if (requested === 'global') return entry.scope === 'global';
  if (requested === 'project') return entry.scope === 'project' || String(entry.scope).startsWith('project:');
  if (requested === 'session') return entry.scope === `session:${sessionId || 'unknown'}`;
  return true;
}

function score(entry, query, qTokens, now, settings) {
  const eTokens = tokens(`${entry.key} ${entry.content} ${(entry.tags || []).join(' ')}`);
  let hit = 0;
  for (const t of qTokens) if (eTokens.has(t)) hit += 1;
  const keyword = qTokens.size ? hit / qTokens.size : 0;
  const tagHit = (entry.tags || []).filter((t) => qTokens.has(normalize(t))).length;
  const tag = tagHit / Math.max(1, (entry.tags || []).length);
  const exact = normalize(entry.content).includes(query) ? 1 : 0;
  const ageDays = (now - (Number(entry.createdAt) || now)) / 86400000;
  const fresh = Math.max(0, 1 - ageDays / 180);
  const confidence = store.isActive(entry, now, settings) ? Number(entry.confidence) || 0.5 : (Number(entry.confidence) || 0.5) * 0.3;
  const access = Math.min(1, Math.log(1 + (Number(entry.accessCount) || 0)) / 5);
  const penalty = (entry.quarantined ? 0.30 : 0) + (entry.supersededBy ? 0.15 : 0);
  // Freshness, confidence and popularity are tie-breakers, not relevance.
  // Without a lexical or tag match, an unrelated recent item must never leak
  // into recall merely because it is new or frequently accessed.
  if (hit === 0 && tagHit === 0 && exact === 0) return 0;
  return WEIGHTS.keyword * keyword + WEIGHTS.tag * tag + WEIGHTS.exact * exact
    + WEIGHTS.fresh * fresh + WEIGHTS.confidence * confidence + WEIGHTS.access * access - penalty;
}

function dedupeRanked(ranked) {
  const out = [];
  for (const item of ranked) {
    if (out.some((kept) => jaccard(kept.e.content, item.e.content) > 0.6)) continue;
    out.push(item);
  }
  return out;
}

async function search(input, settings, context, entriesOverride) {
  const query = normalize(typeof input.query === 'string' ? input.query : '').slice(0, 500);
  if (!query) throw Object.assign(new Error('query is required'), { code: 'INVALID_ARGUMENT' });
  const qTokens = tokens(query);
  if (qTokens.size === 0) throw Object.assign(new Error('query must contain searchable letters or numbers'), { code: 'INVALID_ARGUMENT' });
  const limit = clampLimit(input.limit);
  const now = Date.now();
  const entries = Array.isArray(entriesOverride) ? entriesOverride : [...await store.readAll(), ...(Array.isArray(settings.globalEntries) ? settings.globalEntries : [])];
  const ranked = entries
    .filter((e) => !e.supersededBy && !e.quarantined && scopeMatch(e, input.scope || 'all', context || {}))
    .map((e) => ({ e, s: score(e, query, qTokens, now, settings) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit * 3);
  const picked = dedupeRanked(ranked).slice(0, limit);
  const ids = picked.map((r) => r.e.id);
  try {
    await store.touch(ids, settings);
  } catch (err) {
    // Recall must still answer when hit counters cannot be persisted.
  }
  return {
    text: wrapAsData(picked.map((r) => r.e), { injected: ids.length, matched: ranked.length, scope: input.scope || 'all' }),
    ids,
    matched: ranked.length,
    query,
  };
}

module.exports = { search };

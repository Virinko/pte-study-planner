const PROGRESS_KEY = 'progress';
const PART_NAMES = new Set([
  'version', 'settings', 'phases', 'tasks', 'dailyLogs', 'dailyTargets', 'dailyNotes',
  'answerEntries', 'recallTemplates', 'recallEntryTemplates', 'reviewPlans',
  'reviewLogs', 'skippedReviewRegistrations', 'timeLogs', 'studyTimeEntries',
  'progressRestarts',
]);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  },
});

function isAuthorized(request, env) {
  const password = request.headers.get('x-app-password') || '';
  return Boolean(env.APP_PASSWORD) && password === env.APP_PASSWORD;
}

async function ensureSchema(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS progress_meta (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, updated_at TEXT NOT NULL, mutation_id TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS progress_parts (name TEXT PRIMARY KEY, value TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS progress_mutations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL)'),
  ]);
}

async function readProgress(db) {
  const [metaResult, partsResult] = await db.batch([
    db.prepare('SELECT revision, updated_at FROM progress_meta WHERE id = 1'),
    db.prepare('SELECT name, value FROM progress_parts'),
  ]);
  const meta = metaResult.results[0];
  if (!meta) return null;
  const progress = Object.fromEntries(partsResult.results.map(({ name, value }) => [name, JSON.parse(value)]));
  return { revision: meta.revision, progress: { ...progress, updatedAt: meta.updated_at } };
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function initializeFromVerifiedBackup(env) {
  const existing = await readProgress(env.PROGRESS_DB);
  if (existing) return existing;
  if (!/^[a-f0-9]{64}$/.test(env.MIGRATION_SHA256 || '')) return null;

  const raw = await env.PROGRESS_KV.get(PROGRESS_KEY, 'text');
  if (!raw || await sha256(raw) !== env.MIGRATION_SHA256) return null;
  const source = JSON.parse(raw);
  if (!source || typeof source !== 'object' || !Array.isArray(source.tasks)) return null;
  const updatedAt = source.updatedAt || '';
  const parts = Object.entries(source).filter(([name]) => PART_NAMES.has(name));
  await env.PROGRESS_DB.batch([
    env.PROGRESS_DB.prepare('INSERT OR IGNORE INTO progress_meta (id, revision, updated_at, mutation_id) VALUES (1, 1, ?, ?)').bind(updatedAt, 'migration'),
    ...parts.map(([name, value]) => env.PROGRESS_DB.prepare('INSERT OR IGNORE INTO progress_parts (name, value) VALUES (?, ?)').bind(name, JSON.stringify(value))),
  ]);
  return readProgress(env.PROGRESS_DB);
}

export async function onRequestGet({ request, env }) {
  if (!isAuthorized(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
  if (!env.PROGRESS_DB) return json({ ok: false, error: '数据库未绑定' }, 503);
  try {
    await ensureSchema(env.PROGRESS_DB);
    const state = await initializeFromVerifiedBackup(env);
    if (!state) return json({ ok: false, error: '迁移校验尚未通过，进度保持只读' }, 503);
    return json({ ...state.progress, syncRevision: state.revision });
  } catch {
    return json({ ok: false, error: '读取云端进度失败' }, 503);
  }
}

export async function onRequestPost({ request, env }) {
  if (!isAuthorized(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
  if (!env.PROGRESS_DB) return json({ ok: false, error: '数据库未绑定' }, 503);
  let mutation;
  try {
    mutation = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }
  const { mutationId, baseRevision, changes } = mutation || {};
  if (typeof mutationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(mutationId)
    || !Number.isSafeInteger(baseRevision) || baseRevision < 1
    || !changes || typeof changes !== 'object' || Array.isArray(changes)
    || !Object.keys(changes).length || Object.keys(changes).some((name) => !PART_NAMES.has(name))) {
    return json({ ok: false, error: '此页面版本不支持安全保存，请刷新页面' }, 426);
  }
  try {
    await ensureSchema(env.PROGRESS_DB);
    const current = await readProgress(env.PROGRESS_DB);
    if (!current) return json({ ok: false, error: '进度尚未迁移' }, 503);
    const prior = await env.PROGRESS_DB.prepare('SELECT revision FROM progress_mutations WHERE id = ?').bind(mutationId).first();
    if (prior) return json({ ok: true, revision: current.revision, progress: current.progress, updatedAt: current.progress.updatedAt });
    if (baseRevision !== current.revision) return json({ ok: false, error: '云端进度已更新，请重新拉取', revision: current.revision }, 409);

    const updatedAt = new Date().toISOString();
    const statements = [
      env.PROGRESS_DB.prepare('UPDATE progress_meta SET revision = revision + 1, updated_at = ?, mutation_id = ? WHERE id = 1 AND revision = ?').bind(updatedAt, mutationId, baseRevision),
      ...Object.entries(changes).map(([name, value]) => env.PROGRESS_DB.prepare('INSERT INTO progress_parts (name, value) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM progress_meta WHERE mutation_id = ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').bind(name, JSON.stringify(value), mutationId)),
      env.PROGRESS_DB.prepare('INSERT INTO progress_mutations (id, revision) SELECT ?, revision FROM progress_meta WHERE mutation_id = ?').bind(mutationId, mutationId),
    ];
    const result = await env.PROGRESS_DB.batch(statements);
    if (result[0].meta.changes !== 1) {
      const duplicate = await env.PROGRESS_DB.prepare('SELECT revision FROM progress_mutations WHERE id = ?').bind(mutationId).first();
      if (!duplicate) return json({ ok: false, error: '云端进度已更新，请重新拉取' }, 409);
    }
    const saved = await readProgress(env.PROGRESS_DB);
    return json({ ok: true, revision: saved.revision, progress: saved.progress, updatedAt: saved.progress.updatedAt });
  } catch {
    return json({ ok: false, error: '保存云端进度失败' }, 503);
  }
}

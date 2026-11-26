import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { onRequestGet, onRequestPost } from '../functions/api/progress.js';

class TestD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }

  prepare(sql) {
    const statement = this.db.prepare(sql);
    const wrap = (params) => ({
      bind: (...values) => wrap(values),
      first: async () => statement.get(...params) ?? null,
      run: async () => this.execute(statement, sql, params),
      execute: () => this.execute(statement, sql, params),
    });
    return wrap([]);
  }

  execute(statement, sql, params) {
    if (/^\s*SELECT\b/i.test(sql)) {
      return { results: statement.all(...params), meta: { changes: 0 } };
    }
    const result = statement.run(...params);
    return { results: [], meta: { changes: Number(result.changes) } };
  }

  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.execute());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

const password = 'test-password';
const raw = JSON.stringify({ version: 7, tasks: [{ id: 'one', done: 1 }], dailyLogs: [], updatedAt: '2026-11-23T10:00:00.000Z' });
const hash = createHash('sha256').update(raw).digest('hex');

function request(method, body) {
  return new Request('https://test.example/api/progress', {
    method,
    headers: { 'x-app-password': password, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test('verified migration, version check, retry, and old client rejection', async () => {
  const env = {
    APP_PASSWORD: password,
    MIGRATION_SHA256: hash,
    PROGRESS_DB: new TestD1(),
    PROGRESS_KV: { get: async () => raw },
  };
  const first = await onRequestGet({ request: request('GET'), env });
  assert.equal(first.status, 200);
  const source = await first.json();
  assert.equal(source.syncRevision, 1);
  assert.deepEqual(source.tasks, [{ id: 'one', done: 1 }]);

  const old = await onRequestPost({ request: request('POST', source), env });
  assert.equal(old.status, 426);

  const mutationId = '11111111-1111-4111-8111-111111111111';
  const change = { mutationId, baseRevision: 1, changes: { tasks: [{ id: 'one', done: 2 }] } };
  const saved = await onRequestPost({ request: request('POST', change), env });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 2);

  const duplicate = await onRequestPost({ request: request('POST', change), env });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).revision, 2);

  const stale = await onRequestPost({ request: request('POST', {
    mutationId: '22222222-2222-4222-8222-222222222222',
    baseRevision: 1,
    changes: { tasks: [{ id: 'one', done: 0 }] },
  }), env });
  assert.equal(stale.status, 409);
  const latest = await (await onRequestGet({ request: request('GET'), env })).json();
  assert.deepEqual(latest.tasks, [{ id: 'one', done: 2 }]);
  assert.equal(latest.syncRevision, 2);
});

test('mismatched backup hash keeps D1 empty and read only', async () => {
  const env = {
    APP_PASSWORD: password,
    MIGRATION_SHA256: '0'.repeat(64),
    PROGRESS_DB: new TestD1(),
    PROGRESS_KV: { get: async () => raw },
  };
  const response = await onRequestGet({ request: request('GET'), env });
  assert.equal(response.status, 503);
  assert.equal(env.PROGRESS_DB.db.prepare('SELECT COUNT(*) AS count FROM progress_parts').get().count, 0);
});

test('timer append preserves cloud data, checks revisions and deduplicates retries', async () => {
  const env = {
    APP_PASSWORD: password, MIGRATION_SHA256: hash,
    PROGRESS_DB: new TestD1(), PROGRESS_KV: { get: async () => raw },
  };
  await onRequestGet({ request: request('GET'), env });
  const makeEntry = (id, timeType = 'main') => ({
    id, date: '2026-11-26', taskId: 'one', reviewPlanId: timeType === 'review' ? 'review-one' : '',
    taskName: 'RS 练习', examType: 'RS', durationSeconds: 73, timeType, source: 'timer', note: '计时',
    startAt: '2026-11-26T01:00:00.000Z', endAt: '2026-11-26T01:01:13.000Z', createdAt: '2026-11-26T01:01:13.000Z',
  });
  const entry = makeEntry('33333333-3333-4333-8333-333333333333');
  const append = { mutationId: entry.id, baseRevision: 1, timerEntry: entry };
  const saved = await onRequestPost({ request: request('POST', append), env });
  assert.equal(saved.status, 200);
  const state = await saved.json();
  assert.equal(state.revision, 2);
  assert.deepEqual(state.progress.studyTimeEntries, [entry]);
  assert.equal(state.progress.timeLogs[entry.date][0].durationSeconds, 73);
  assert.deepEqual(state.progress.tasks, [{ id: 'one', done: 1 }]);

  const review = makeEntry('44444444-4444-4444-8444-444444444444', 'review');
  const stale = await onRequestPost({ request: request('POST', { mutationId: review.id, baseRevision: 1, timerEntry: review }), env });
  assert.equal(stale.status, 409);
  const retried = await onRequestPost({ request: request('POST', { mutationId: review.id, baseRevision: 2, timerEntry: review }), env });
  assert.equal(retried.status, 200);
  const duplicate = await onRequestPost({ request: request('POST', append), env });
  assert.equal(duplicate.status, 200);
  const latest = await duplicate.json();
  assert.equal(latest.revision, 3);
  assert.deepEqual(latest.progress.studyTimeEntries, [entry, review]);
  assert.deepEqual(latest.progress.timeLogs[entry.date].map((item) => item.type), ['task', 'review']);

  const badEntry = { ...makeEntry('55555555-5555-4555-8555-555555555555'), durationSeconds: -1 };
  for (const payload of [
    { mutationId: badEntry.id, baseRevision: 3, timerEntry: badEntry },
    { mutationId: badEntry.id, baseRevision: 3, timerEntry: { ...badEntry, durationSeconds: 73 }, changes: { tasks: [] } },
  ]) {
    assert.equal((await onRequestPost({ request: request('POST', payload), env })).status, 426);
  }
  assert.equal((await (await onRequestGet({ request: request('GET'), env })).json()).syncRevision, 3);
});

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

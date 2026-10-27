import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import sinon from 'sinon';
import { createWithAdvisoryLock } from '../src/index.js';

function fixture () {
  const query = sinon.stub();
  query.onFirstCall().resolves({ rows: [] });
  query.onSecondCall().resolves({ rows: [{ unlocked: true }] });
  const release = sinon.spy();
  const connect = sinon.stub().resolves({ query, release });
  const pool = { options: { max: 2 }, connect };
  return { pool: pool as unknown as Pool, query, release, connect };
}

test('holds a dedicated connection, forwards arguments and releases before resolving', async () => {
  const { pool, query, release } = fixture();
  const key: [string, string] = ['app', 'job'];
  const wrap = createWithAdvisoryLock(pool, key);
  key[0] = 'mutated';
  const run = wrap(async (value: number) => {
    assert.equal(query.callCount, 1);
    assert.equal(release.callCount, 0);
    return value * 2;
  });
  assert.equal(await run(21), 42);
  assert.deepEqual(query.firstCall.args[1], ['app', 'job']);
  assert.deepEqual(query.secondCall.args[1], ['app', 'job']);
  sinon.assert.calledOnceWithExactly(release, false);
});

test('preserves operation errors including an undefined rejection', async () => {
  for (const reason of [new Error('operation'), undefined]) {
    const { pool, release } = fixture();
    const run = createWithAdvisoryLock(pool, ['app', 'job'])(async () => {
      throw reason;
    });
    const result = await Promise.allSettled([run()]);
    assert.equal(result[0]?.status, 'rejected');
    assert.equal((result[0] as PromiseRejectedResult).reason, reason);
    sinon.assert.calledOnceWithExactly(release, false);
  }
});

test('destroys the connection when acquisition fails without running the operation', async () => {
  const { pool, query, release } = fixture();
  const error = new Error('connection lost');
  query.onFirstCall().rejects(error);
  const operation = sinon.stub().resolves();
  await assert.rejects(createWithAdvisoryLock(pool, ['app', 'job'])(operation)(), error);
  sinon.assert.notCalled(operation);
  sinon.assert.calledOnce(query);
  sinon.assert.calledOnceWithExactly(release, true);
});

test('destroys the connection on an unsuccessful unlock', async () => {
  const { pool, query, release } = fixture();
  query.onSecondCall().resolves({ rows: [{ unlocked: false }] });
  await assert.rejects(createWithAdvisoryLock(pool, ['app', 'job'])(async () => 1)(), /lock was not released/);
  sinon.assert.calledOnceWithExactly(release, true);
});

test('preserves both failures when the operation and unlock fail', async () => {
  const { pool, query, release } = fixture();
  const unlockError = new Error('unlock failed');
  query.onSecondCall().rejects(unlockError);
  const result = await Promise.allSettled([
    // Regression case: JavaScript promises can reject without a reason.
    // eslint-disable-next-line no-throw-literal
    createWithAdvisoryLock(pool, ['app', 'job'])(async () => { throw undefined; })(),
  ]);
  const error = (result[0] as PromiseRejectedResult).reason;
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(error.errors, [undefined, unlockError]);
  sinon.assert.calledOnceWithExactly(release, true);
});

test('rejects a pool that cannot reserve a separate connection', async () => {
  const { pool, connect } = fixture();
  pool.options.max = 1;
  await assert.rejects(createWithAdvisoryLock(pool, ['app', 'job'])(async () => {})(), /at least two/);
  sinon.assert.notCalled(connect);
});

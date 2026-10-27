import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import { createWithAdvisoryLock } from '../../src/index.js';

test('separate pools serialize shared keys, allow independent keys and recover after failure', { timeout: 120000 }, async t => {
  const postgres = await new GenericContainer('postgres:17-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'locks' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const pools: Pool[] = [];
  t.after(async () => {
    try { await Promise.all(pools.map(pool => pool.end())); } finally { await postgres.stop(); }
  });
  const config = { host: postgres.getHost(), port: postgres.getMappedPort(5432), user: 'test', password: 'test', database: 'locks', max: 4 };
  const first = new Pool(config);
  const second = new Pool(config);
  pools.push(first, second);
  await first.query('create table counter (value integer not null); insert into counter values (0)');
  let active = 0;
  let peak = 0;
  const increment = (pool: Pool) => createWithAdvisoryLock(pool, ['integration', 'counter'])(async () => {
    active++;
    peak = Math.max(peak, active);
    try {
      const result = await pool.query<{ value: number }>('select value from counter');
      await delay(20);
      await pool.query('update counter set value = $1', [result.rows[0]!.value + 1]);
    } finally { active--; }
  });
  // Each pool has enough capacity for its lock holders and the protected work.
  await Promise.all([increment(first)(), increment(second)()]);
  assert.equal(peak, 1);
  assert.equal((await first.query('select value from counter')).rows[0].value, 2);

  await createWithAdvisoryLock(first, ['integration', 'outer'])(async () => {
    await createWithAdvisoryLock(second, ['integration', 'other'])(async () => {
      await second.query('select 1');
    })();
  })();

  const failure = new Error('retryable operation');
  await assert.rejects(createWithAdvisoryLock(first, ['integration', 'counter'])(async () => { throw failure; })(), failure);
  assert.equal(await createWithAdvisoryLock(second, ['integration', 'counter'])(async (n: number) => n)(42), 42);
  const remaining = await first.query("select count(*)::int as count from pg_locks where locktype = 'advisory'");
  assert.equal(remaining.rows[0].count, 0);
});

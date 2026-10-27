import type { Pool } from 'pg';

export const createWithAdvisoryLock = (
  pool: Pool,
  key: readonly [string, string]
) => {
  const lockKey = [...key];

  return <Args extends unknown[], Result>(
    operation: (...args: Args) => Promise<Result>
  ) =>
    async (...args: Args): Promise<Result> => {
      if (pool.options.max !== undefined && pool.options.max < 2) {
        throw new Error(
          'Advisory locking requires at least two PostgreSQL connections'
        );
      }
      const client = await pool.connect();
      let locked = false;
      let reusable = false;
      let failure: unknown;
      let failed = false;
      let result!: Result;

      try {
        await client.query(
          'select pg_advisory_lock(hashtext($1), hashtext($2))',
          lockKey
        );
        locked = true;
        result = await operation(...args);
      } catch (error) {
        failure = error;
        failed = true;
      }

      try {
        if (locked) {
          const unlock = await client.query<{ unlocked: boolean }>(
            'select pg_advisory_unlock(hashtext($1), hashtext($2)) as unlocked',
            lockKey
          );
          if (unlock.rows[0]?.unlocked !== true) {
            throw new Error('Migration lock was not released');
          }
          reusable = true;
        }
      } catch (error) {
        failure =
          !failed
            ? error
            : new AggregateError(
              [failure, error],
              'Operation and lock release failed'
            );
        failed = true;
      } finally {
        client.release(!reusable);
      }

      if (failed) {
        throw failure;
      }

      return result;
    };
};

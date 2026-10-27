import { Pool } from 'pg';
import { createWithAdvisoryLock } from '../src/index.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const withJobLock = createWithAdvisoryLock(pool, ['billing', 'refresh-report']);
const refreshReport = withJobLock(async (accountId: string): Promise<string> => {
  await pool.query('select $1::text as account_id', [accountId]);
  return accountId;
});

try {
  console.log(await refreshReport('account-123'));
} finally {
  await pool.end();
}

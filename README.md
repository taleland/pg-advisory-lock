# @taleland/pg-advisory-lock

Wrap an asynchronous operation with a PostgreSQL session advisory lock. Processes connected to the same database and using the same two-part key serialize their work, even when they use different connection pools.

**Initial implementation for review. No npm release has been published from this repository.**

## Requirements and installation

Node.js 22.13 or newer, PostgreSQL, and `pg` 8.23 or newer within major version 8. CI uses Node.js 24 and PostgreSQL 17.

After the initial release is approved and published:

```sh
npm install @taleland/pg-advisory-lock pg
npm install --save-dev @types/pg
```

The package is ESM and includes TypeScript declarations. During initial review, use the local checkout with `npm ci` and `npm run build`.

## Usage

```ts
import { Pool } from 'pg';
import { createWithAdvisoryLock } from '@taleland/pg-advisory-lock';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const withJobLock = createWithAdvisoryLock(pool, ['billing', 'refresh-report']);

const refreshReport = withJobLock(async (accountId: string): Promise<string> => {
  // Replace with application work. This query uses another pool connection.
  await pool.query('select $1::text as account_id', [accountId]);
  return accountId;
});

try {
  const accountId = await refreshReport('account-123');
  console.log(accountId);
} finally {
  await pool.end();
}
```

The same example is compiled from [examples/serialized-job.ts](examples/serialized-job.ts):

```sh
npm ci
npm run build
DATABASE_URL=postgresql://user:password@localhost:5432/app node dist/examples/serialized-job.js
```

The wrapper preserves argument and result types. Create it once for a fixed key and call the wrapped function whenever the operation should run under that lock.

### Lock per resource

Choose a key based on the logical operation and resource to serialize work for one resource while allowing unrelated resources to proceed:

```ts
async function refreshAccount(accountId: string): Promise<void> {
  const withAccountLock = createWithAdvisoryLock(pool, ['refresh-account', accountId]);
  await withAccountLock(async () => {
    await pool.query('select $1::text as account_id', [accountId]);
    // Perform this account's protected work here.
  })();
}
```

All callers must agree on the same key and database. The key is snapshotted when the wrapper is created. Internally each string is hashed with PostgreSQL `hashtext`, then passed to the two-integer form of `pg_advisory_lock`. Hash collisions can serialize unrelated keys, so keys are not a collision-free identifier system.

## Connection and failure behavior

The function reserves one pool client for the session lock, awaits the operation, unlocks using that same client, then returns or rethrows. The protected operation receives only its original arguments; it does not receive the lock client. Its database work uses its own connection or pool.

- Configure at least two pool connections. An explicitly configured `max` below two is rejected before acquiring a client.
- Size the pool for concurrent lock holders/waiters **plus** the protected work. If all clients are held by waiting lock calls while the current operation needs another client, the pool can deadlock. Limit concurrent invocations or use a dedicated lock pool and a separate work pool.
- Calls wait for lock acquisition; there is no built-in try-lock, cancellation, or timeout. Configure PostgreSQL/pool timeouts as appropriate for the application.
- The lock is session-scoped, not a database transaction. Work done by the callback is not rolled back automatically when it throws.
- The lock is released on success and on operation failure. A client with failed acquisition or an unconfirmed unlock is destroyed instead of returned to the pool.
- If both the operation and unlock fail, an `AggregateError` preserves both failures. Rejections with `undefined` are preserved as rejections too.
- A lost database session releases its lock. This helper provides no fencing token, so it cannot guarantee exclusivity for external side effects after a connection loss.
- Avoid nested acquisition of the same key through separate connections: an inner operation can wait forever on the outer operation's lock.

## Development

```sh
npm ci
npm run lint
npm run build
npm test
npm pack --dry-run
```

`npm run test:unit` checks argument forwarding and cleanup/error handling. `npm run test:integration` requires Docker and starts an isolated PostgreSQL container to verify serialization across separate pools, independent keys, and reacquisition after failure. Build before running tests. The published tarball includes only compiled library code and declarations, README, changelog, and license.

## Release preparation

Build, lint, Conventional Commit PR checks, Dependabot, and semantic-release follow `taleland/nestjs-auth0`. `AGENTS.md` is copied unchanged, including the local Conventional Commits specification.

Publishing is disabled until the repository variable `NPM_PUBLISH_ENABLED` is explicitly set to `true`. Before enabling it, approve the initial implementation and configure npm Trusted Publishing for `taleland/pg-advisory-lock`, workflow `publish.yml`, following npm's initial-package setup requirements. The workflow uses Node.js 24 and requires no stored `NPM_TOKEN`. Initial review does not create a release.

## License

[Apache License 2.0](LICENSE).

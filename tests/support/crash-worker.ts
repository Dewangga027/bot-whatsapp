import { Client } from 'pg';
import { loadConfig } from '../../src/config.js';
import { startWorker } from '../../src/worker.js';

const [phase, databaseName, redisDb] = process.argv.slice(2);
if (process.env.TEST_ISOLATED !== 'true' || process.env.RUN_INTEGRATION_TESTS !== 'true'
  || process.env.PGHOST !== 'db-test' || process.env.REDIS_HOST !== 'redis-test'
  || !databaseName || !/^monitoring_test_[a-f0-9]{32}$/.test(databaseName)
  || redisDb !== '1' || (phase !== 'before-commit' && phase !== 'after-commit')) {
  throw new Error('Crash harness requires an isolated queue integration fixture');
}

async function holdAtBoundary(): Promise<never> {
  process.send?.(phase);
  return Promise.withResolvers<never>().promise;
}

// Wrap the real pg client, retaining BEGIN/INSERT/COMMIT and the live transaction.
Client.prototype.query = new Proxy(Client.prototype.query, {
  apply(target, thisArg, argumentsList) {
    if (argumentsList[0] !== 'COMMIT') {
      return Reflect.apply(target, thisArg, argumentsList);
    }
    return (async function commitAtBoundary() {
      if (phase === 'before-commit') { await holdAtBoundary(); }
      const result: unknown = await Reflect.apply(target, thisArg, argumentsList);
      if (phase === 'after-commit') { await holdAtBoundary(); }
      return result;
    })();
  },
});

try {
  const config = loadConfig('migrate');
  const redisConfig = loadConfig('ops');
  if (config.service !== 'migrate' || redisConfig.service !== 'ops') {
    throw new Error('Unexpected crash harness configuration');
  }
  await startWorker({
    service: 'worker', redis: { ...redisConfig.redis, ...{ db: 1 } },
    database: {
      ...config.database, database: databaseName, user: 'monitor_worker', password: config.workerPassword,
    },
  });
} catch {
  process.send?.('worker-error');
  process.exitCode = 1;
}

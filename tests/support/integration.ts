import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import type { Job } from 'bullmq';
import { loadConfig } from '../../src/config.js';
import type { ServiceConfig } from '../../src/config.js';
import { createDatabase } from '../../src/database.js';
import type { Database } from '../../src/database.js';
import { runMigrations } from '../../src/migrate.js';
import { createQueue } from '../../src/queue.js';
import type { ChecklistQueue } from '../../src/queue.js';
import { startWorker } from '../../src/worker.js';
import type { WorkerHandle } from '../../src/worker.js';
import type { IncomingMessage, JobData, JobResult } from '../../src/types.js';

export const VALID_BODY = 'Monitoring drawdown\nMesin filling: I\nKetebalan: 8,0\nTekanan: 2,9\nVacuum: -0,5\nKeterangan: Kondisi bagus';

export type IntegrationContext = {
  sessionKey: string;
  database: Database;
  readerDatabase: Database;
  queue: ChecklistQueue;
  redisOptions: RedisOptions;
  workerConfig: Extract<ServiceConfig, { service: 'worker' }>;
  apiConfig: Extract<ServiceConfig, { service: 'api' }>;
  adminPool: Pool;
  message: (overrides?: Partial<IncomingMessage>) => IncomingMessage;
  startWorker: () => Promise<WorkerHandle>;
  waitForJob: (id: string, state?: 'completed' | 'failed' | 'active' | 'waiting', timeoutMs?: number) => Promise<Job<JobData, JobResult, 'checklist'>>;
  close: () => Promise<void>;
};

export async function createIntegrationContext(namespace: 'queue' | 'api'): Promise<IntegrationContext> {
  if (process.env.NODE_ENV !== 'test'
    || process.env.RUN_INTEGRATION_TESTS !== 'true' || process.env.TEST_ISOLATED !== 'true'
    || process.env.PGDATABASE !== 'monitoring_test'
    || process.env.PGHOST !== 'db-test' || process.env.REDIS_HOST !== 'redis-test') {
    throw new Error('Integration tests require NODE_ENV=test, isolated db-test/redis-test, monitoring_test, TEST_ISOLATED=true and RUN_INTEGRATION_TESTS=true');
  }
  const migrateConfig = loadConfig('migrate');
  const opsConfig = loadConfig('ops');
  if (migrateConfig.service !== 'migrate' || opsConfig.service !== 'ops') {
    throw new Error('Unexpected test service configuration');
  }
  const suffix = randomUUID().replaceAll('-', '');
  const databaseName = `monitoring_test_${suffix}`;
  const sessionKey = `test-${namespace}-${suffix}`;
  const redisOptions = { ...opsConfig.redis, db: namespace === 'queue' ? 1 : 2 };
  const admin = new Pool(migrateConfig.database);
  const lock = new Redis({ ...opsConfig.redis, db: 0, maxRetriesPerRequest: 1 });
  lock.on('error', () => {});
  const lockKey = `integration:${namespace}`;
  let locked = false;
  let created = false;
  let queue: ChecklistQueue | undefined;
  let queueMayClean = false;
  let database: Database | undefined;
  let readerDatabase: Database | undefined;
  let adminPool: Pool | undefined;
  const workers: WorkerHandle[] = [];
  let closing: Promise<void> | undefined;

  async function cleanup(): Promise<void> {
    const failures: unknown[] = [];
    for (const worker of workers) {
      try { await worker.close(); } catch (error) { failures.push(error); }
    }
    if (queue) {
      if (queueMayClean) {
        try { await queue.obliterate({ force: true }); } catch (error) { failures.push(error); }
      }
      try { await queue.close(); } catch (error) { failures.push(error); }
    }
    for (const resource of [database, readerDatabase, adminPool]) {
      try {
        if (resource instanceof Pool) { await resource.end(); }
        else if (resource) { await resource.close(); }
      } catch (error) { failures.push(error); }
    }
    if (created) {
      try { await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); }
      catch (error) { failures.push(error); }
    }
    if (locked) {
      try {
        await lock.eval('if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end', 1, lockKey, sessionKey);
      } catch (error) { failures.push(error); }
    }
    lock.disconnect();
    try { await admin.end(); } catch (error) { failures.push(error); }
    if (failures.length > 0) { throw new Error('Isolated integration resource cleanup failed'); }
  }

  try {
    if (lock.status !== 'ready') { await once(lock, 'ready'); }
    locked = await lock.set(lockKey, sessionKey, 'NX') === 'OK';
    if (!locked) { throw new Error(`Another ${namespace} integration context still owns its test Redis database`); }
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const dbSettings = { ...migrateConfig.database, database: databaseName };
    const migrationLock = await admin.connect();
    try {
      // Roles are cluster-wide even though each case owns a separate database.
      await migrationLock.query('SELECT pg_advisory_lock(850012)');
      try { await runMigrations({ ...migrateConfig, database: dbSettings }); }
      finally { await migrationLock.query('SELECT pg_advisory_unlock(850012)'); }
    } finally {
      migrationLock.release();
    }
    const workerConfig: Extract<ServiceConfig, { service: 'worker' }> = {
      service: 'worker', redis: redisOptions,
      database: { ...dbSettings, user: 'monitor_worker', password: migrateConfig.workerPassword },
    };
    const apiConfig: Extract<ServiceConfig, { service: 'api' }> = {
      service: 'api', redis: redisOptions,
      database: { ...dbSettings, user: 'monitor_reader', password: migrateConfig.readerPassword },
      apiReadToken: `test-read-${suffix}`, opsUser: 'test-operator', opsPassword: `test-ops-${suffix}`,
    };
    database = createDatabase(workerConfig.database);
    readerDatabase = createDatabase(apiConfig.database);
    adminPool = new Pool(dbSettings);
    queue = createQueue(redisOptions);
    const client = queue.redisClient;
    if (client.status !== 'ready') { await once(client, 'ready'); }
    if (await queue.getJobCountByTypes('wait', 'active', 'completed', 'failed', 'delayed', 'paused') !== 0) {
      // Refuse leftovers rather than deleting another interrupted test's evidence.
      throw new Error('Test Redis database is not empty; inspect previous test resources before retrying');
    }
    queueMayClean = true;
    const ownedQueue = queue;
    return {
      sessionKey, database, readerDatabase, queue, redisOptions, workerConfig, apiConfig, adminPool,
      message(overrides = {}) {
        return {
          session_key: sessionKey, message_id: randomUUID(), source_timestamp: 1794787200,
          chat_id: 'test-group@g.us', sender_id: null, received_at: '2026-11-16T00:00:00.000Z',
          raw_body: VALID_BODY, message_type: 'chat', ...overrides,
        };
      },
      async startWorker() {
        const handle = await startWorker(workerConfig);
        workers.push(handle);
        return handle;
      },
      async waitForJob(id, state = 'completed', timeoutMs = 10_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const job = await ownedQueue.getJob(id);
          if (job && await job.getState() === state) { return job; }
          await delay(25);
        }
        throw new Error(`Test job did not reach ${state} before its deadline`);
      },
      close() {
        closing ??= cleanup();
        return closing;
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { once } from 'node:events';
import type { PoolClient } from 'pg';
import { createQueue, enqueueMessage, getJobId } from '../src/queue.js';
import { retryFailedJob } from '../src/ops.js';
import { processChecklist, startWorker } from '../src/worker.js';
import type { WorkerHandle } from '../src/worker.js';
import { createIntegrationContext } from './support/integration.js';
import { spawnCrashWorker } from './support/pipeline.js';
import type { CrashProcess } from './support/pipeline.js';

const exec = promisify(execFile);

test('queue and worker contracts on isolated Redis/PostgreSQL', { timeout: 240_000 }, async (t) => {
  const context = await createIntegrationContext('queue');
  t.after(() => context.close());

  await t.test('rejects malformed metadata before staging and keeps null sender', async () => {
    assert.equal(getJobId(context.message({ session_key: 'fixture', message_id: 'a:b' })),
      'wa-88f419bb4e828355eff422cee2327f0b526d808609c95bcd0ecda8ce8ca4224a');
    for (const malformed of [null, {}, { ...context.message(), sender_id: 123 },
      { ...context.message(), raw_body: [] }, { ...context.message(), source_timestamp: '123' }]) {
      await assert.rejects(Reflect.apply(enqueueMessage, undefined, [malformed, context.queue]), { code: 'INVALID_MESSAGE' });
    }
    for (const overrides of [
      { source_timestamp: -1 }, { source_timestamp: 1.1 }, { source_timestamp: Number.MAX_SAFE_INTEGER + 1 },
      { received_at: '2026-02-30T00:00:00.000Z' }, { received_at: '2026-11-16T00:00:00+07:00' },
      { session_key: '' }, { message_id: '' },
    ]) {
      const message = context.message(overrides);
      await assert.rejects(enqueueMessage(message, context.queue), { code: 'INVALID_MESSAGE' });
      assert.equal(await context.queue.getJob(getJobId(message)), undefined);
    }
    const message = context.message();
    const id = await enqueueMessage(message, context.queue);
    assert.equal((await context.queue.getJob(id))?.data.message.sender_id, null);
  });

  await t.test('stages while worker stopped and duplicate cannot overwrite raw or metadata', async () => {
    const message = context.message({ message_id: 'source:id:1', raw_body: `${context.message().raw_body}\r\n` });
    const before = structuredClone(message);
    const id = await enqueueMessage(message, context.queue);
    assert.match(id, /^wa-[0-9a-f]{64}$/);
    assert.equal(await enqueueMessage({ ...message, raw_body: 'changed raw', sender_id: 'changed' }, context.queue), id);
    assert.notEqual(getJobId({ ...message, session_key: `${message.session_key}-other` }), id);
    const job = await context.queue.getJob(id);
    assert.ok(job);
    assert.equal(await job.getState(), 'waiting');
    assert.deepEqual(job.data, { message: before, parsed: null });
    assert.deepEqual(message, before);
    assert.equal(await context.database.findReport(message), null);
    assert.equal(job.opts.attempts, 1);
    assert.equal(job.opts.removeOnComplete, false);
    assert.equal(job.opts.removeOnFail, false);
    await assert.rejects(retryFailedJob(id, context.queue), { code: 'NOT_FAILED' });
    await context.startWorker();
    const completed = await context.waitForJob(id);
    assert.deepEqual(completed.returnvalue, { status: 'accepted', job_id: id });
    assert.deepEqual(completed.data.message, before);
    const record = await context.database.findReport(message);
    assert.ok(record);
    assert.equal(record.thickness, '8.0');
    assert.equal(record.pressure, '2.9');
    assert.equal(record.vacuum, '-0.5');
    await assert.rejects(retryFailedJob(id, context.queue), { code: 'NOT_FAILED' });
    await completed.remove();
    await enqueueMessage({ ...message, raw_body: 'invalid replacement must never be parsed' }, context.queue);
    const recreated = await context.waitForJob(id);
    assert.deepEqual(recreated.returnvalue, { status: 'accepted', job_id: id });
    assert.deepEqual(await context.database.findReport(message), record);
    const count = await context.adminPool.query('SELECT count(*)::int AS count FROM public.monitoring_drawdown WHERE session_key=$1 AND message_id=$2', [message.session_key, message.message_id]);
    assert.equal(count.rows[0].count, 1);
  });

  await t.test('invalid format completes with errors, no SQL and no native retry', async () => {
    const message = context.message({ raw_body: 'Monitoring drawdown\nMesin filling: I' });
    const id = await enqueueMessage(message, context.queue);
    const job = await context.waitForJob(id);
    assert.equal(job.returnvalue.status, 'invalid');
    if (job.returnvalue.status === 'invalid') { assert.ok(job.returnvalue.errors.length > 0); }
    assert.equal(await context.database.findReport(message), null);
    assert.equal(job.data.parsed, null);
    await assert.rejects(retryFailedJob(id, context.queue), { code: 'NOT_FAILED' });
    await assert.rejects(retryFailedJob('wa-missing', context.queue), { code: 'JOB_NOT_FOUND' });
  });
});

test('technical SQL failure retains jobs until explicit retry, including already committed reports', { timeout: 30_000 }, async (t) => {
  const context = await createIntegrationContext('queue');
  let failedWorker: WorkerHandle | undefined;
  t.after(async () => {
    try { await failedWorker?.close(); } finally { await context.close(); }
  });
  const badConfig = {
    ...context.workerConfig,
    database: { ...context.workerConfig.database, database: 'monitoring_test_missing' },
  };
  const committedMessage = context.message();
  const committedId = await enqueueMessage(committedMessage, context.queue);
  const staged = await context.queue.getJob(committedId);
  assert.ok(staged);
  await processChecklist(staged, context.database);
  const originalRecord = await context.database.findReport(committedMessage);
  assert.ok(originalRecord);
  failedWorker = await startWorker(badConfig);
  const message = context.message();
  const id = await enqueueMessage(message, context.queue);
  const failed = await context.waitForJob(id, 'failed');
  await context.waitForJob(committedId, 'failed');
  assert.equal(failed.attemptsMade, 1);
  assert.equal(failed.failedReason, 'Pemrosesan checklist gagal');
  assert.equal(failed.failedReason.includes(message.raw_body), false);
  await delay(250);
  assert.equal(await failed.getState(), 'failed');
  await failedWorker.close();
  await retryFailedJob(id, context.queue);
  await retryFailedJob(committedId, context.queue);
  await context.startWorker();
  const completed = await context.waitForJob(id);
  assert.equal(completed.returnvalue.status, 'accepted');
  assert.deepEqual(completed.data.message, message);
  assert.ok(await context.database.findReport(message));
  assert.equal((await context.waitForJob(committedId)).returnvalue.status, 'accepted');
  assert.deepEqual(await context.database.findReport(committedMessage), originalRecord);
});

for (const phase of ['before-commit', 'after-commit'] as const) {
  test(`SIGKILL ${phase} recovers with production stalled timing within 90 seconds`, { timeout: 110_000 }, async (t) => {
    const context = await createIntegrationContext('queue');
    let child: CrashProcess | undefined;
    t.after(async () => {
      try { await child?.kill(); } finally { await context.close(); }
    });
    child = spawnCrashWorker(context, phase);
    const message = context.message();
    const id = await enqueueMessage(message, context.queue);
    await child.boundary;
    const job = await context.queue.getJob(id);
    assert.ok(job);
    assert.equal(await job.getState(), 'active');
    assert.deepEqual(job.data.message, message);
    assert.equal(job.data.parsed?.vacuum, '-0.5');
    await assert.rejects(retryFailedJob(id, context.queue), { code: 'NOT_FAILED' });
    const committed = await context.database.findReport(message);
    if (phase === 'before-commit') { assert.equal(committed, null); }
    else { assert.ok(committed); }
    const recoveryStarted = Date.now();
    await child.kill();
    await context.startWorker();
    const completed = await context.waitForJob(id, 'completed', 90_000 - (Date.now() - recoveryStarted));
    assert.ok(Date.now() - recoveryStarted < 90_000);
    assert.equal(completed.returnvalue.status, 'accepted');
    assert.deepEqual(completed.data.message, message);
    const final = await context.database.findReport(message);
    assert.ok(final);
    if (committed) { assert.deepEqual(final, committed); }
    const count = await context.adminPool.query('SELECT count(*)::int AS count FROM public.monitoring_drawdown WHERE session_key=$1 AND message_id=$2', [message.session_key, message.message_id]);
    assert.equal(count.rows[0].count, 1);
  });
}

test('two real workers race one SQL identity and close waits for active work', { timeout: 30_000 }, async (t) => {
  const context = await createIntegrationContext('queue');
  let blocker: PoolClient | undefined;
  let transactionOpen = false;
  t.after(async () => {
    try {
      if (transactionOpen && blocker) { await blocker.query('ROLLBACK'); }
    } finally {
      blocker?.release();
      await context.close();
    }
  });
  blocker = await context.adminPool.connect();
  await blocker.query('BEGIN');
  transactionOpen = true;
  await blocker.query('LOCK TABLE public.monitoring_drawdown IN SHARE MODE');
  const firstWorker = await context.startWorker();
  await context.startWorker();
  const message = context.message();
  const id = getJobId(message);
  const ids = [`${id}-race-a`, `${id}-race-b`];
  for (const jobId of ids) {
    await context.queue.add('checklist', { message, parsed: null }, { jobId });
  }
  await Promise.all(ids.map((jobId) => context.waitForJob(jobId, 'active')));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const jobs = await Promise.all(ids.map((jobId) => context.queue.getJob(jobId)));
    if (jobs.every((job) => job?.data.parsed !== null && job?.data.parsed !== undefined)) { break; }
    await delay(25);
  }
  for (const jobId of ids) {
    assert.ok((await context.queue.getJob(jobId))?.data.parsed);
  }
  let closed = false;
  const closing = firstWorker.close().then(() => { closed = true; });
  await delay(100);
  assert.equal(closed, false);
  await blocker.query('COMMIT');
  transactionOpen = false;
  const completed = await Promise.all(ids.map((jobId) => context.waitForJob(jobId)));
  for (const job of completed) {
    assert.deepEqual(job.returnvalue, { status: 'accepted', job_id: id });
  }
  await closing;
  const count = await context.adminPool.query('SELECT count(*)::int AS count FROM public.monitoring_drawdown WHERE session_key=$1 AND message_id=$2', [message.session_key, message.message_id]);
  assert.equal(count.rows[0].count, 1);
});

test('offline Redis rejects enqueue promptly without a fallback', { timeout: 10_000 }, async (t) => {
  const context = await createIntegrationContext('queue');
  t.after(() => context.close());
  const queue = createQueue({ ...context.redisOptions, host: '127.0.0.1', port: 1, connectTimeout: 200 });
  t.after(() => queue.close());
  const message = context.message();
  const started = Date.now();
  await assert.rejects(enqueueMessage(message, queue), { code: 'NOT_STAGED' });
  assert.ok(Date.now() - started < 2_000);
  assert.equal(await context.database.findReport(message), null);
  assert.equal(await context.queue.getJob(getJobId(message)), undefined);
  const client = queue.redisClient;
  const ended = client.status === 'end'
    ? Promise.resolve()
    : once(client, 'end', { signal: AbortSignal.timeout(2_000) });
  await Promise.all([queue.close(), queue.close()]);
  await ended;
  assert.equal(client.status, 'end');
});

test('one queue survives a disconnected client and retains raw data on reconnect', { timeout: 15_000 }, async (t) => {
  const context = await createIntegrationContext('queue');
  t.after(() => context.close());
  const message = context.message();
  const id = await enqueueMessage(message, context.queue);
  const client = context.queue.redisClient;
  const closed = once(client, 'end');
  client.disconnect();
  await closed;
  const rejected = context.message();
  await assert.rejects(enqueueMessage(rejected, context.queue), { code: 'NOT_STAGED' });
  await client.connect();
  assert.equal(await context.queue.getJob(getJobId(rejected)), undefined);
  assert.deepEqual((await context.queue.getJob(id))?.data.message, message);
  await context.startWorker();
  assert.equal((await context.waitForJob(id)).returnvalue.status, 'accepted');
});

test('offline default/explicit close and operator failure leave no reconnect handles', { timeout: 25_000 }, async (t) => {
  const context = await createIntegrationContext('queue');
  t.after(() => context.close());
  const env = { ...process.env, REDIS_HOST: '127.0.0.1', REDIS_PORT: '1' };
  for (const mode of ['default', 'explicit']) {
    await exec(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e',
      `import { exerciseOfflineQueueClose } from './tests/support/pipeline.ts'; await exerciseOfflineQueueClose('${mode}');`,
    ], { env, timeout: 7_000 });
  }
  await assert.rejects(
    exec(process.execPath, ['--import', 'tsx', 'src/ops.ts', 'retry', 'wa-offline'], { env, timeout: 7_000 }),
    (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error && 'killed' in error && 'stderr' in error);
      assert.equal(error.code, 1);
      assert.equal(error.killed, false);
      assert.equal(typeof error.stderr, 'string');
      assert.match(String(error.stderr), /Perintah operator gagal/);
      assert.doesNotMatch(String(error.stderr), /Stream isn't writeable|enableOfflineQueue|ECONNREFUSED/);
      return true;
    },
  );
});

test('worker and ops help run without credentials or service connections', async () => {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  for (const entry of ['src/worker.ts', 'src/ops.ts']) {
    const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', entry, '--help'], { env, timeout: 5_000 });
    assert.match(stdout, /Penggunaan:/);
    assert.equal(stderr, '');
  }
});

test('integration fixture refuses non-test NODE_ENV before loading credentials', async () => {
  await exec(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    "import assert from 'node:assert/strict'; import { createIntegrationContext } from './tests/support/integration.ts'; await assert.rejects(createIntegrationContext('queue'), /NODE_ENV=test/);",
  ], {
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      NODE_ENV: 'production', RUN_INTEGRATION_TESTS: 'true', TEST_ISOLATED: 'true',
      PGHOST: 'db-test', REDIS_HOST: 'redis-test', PGDATABASE: 'monitoring_test',
    },
    timeout: 5_000,
  });
});

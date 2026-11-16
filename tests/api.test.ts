import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { Worker } from 'bullmq';
import { createApi } from '../src/api.js';
import { createDatabase } from '../src/database.js';
import { createQueue, enqueueMessage, getJobId, QUEUE_NAME } from '../src/queue.js';
import type { IncomingMessage, JobData, JobResult, ParsedChecklist } from '../src/types.js';
import { createIntegrationContext } from './support/integration.js';

const parsed: ParsedChecklist = {
  machine: 'I', thickness: '8.30', pressure: '2.90', vacuum: '-0.50', notes: 'Kondisi bagus',
};
const columns = ['message_id', 'timestamp', 'chat_id', 'sender_id', 'machine', 'thickness', 'pressure', 'vacuum', 'notes', 'status'];

function message(sessionKey: string, id: string): IncomingMessage {
  return {
    session_key: sessionKey,
    message_id: id,
    source_timestamp: 1_800_000_000,
    chat_id: 'test-group@g.us',
    sender_id: null,
    received_at: '2026-11-16T10:00:00.000Z',
    raw_body: 'Monitoring drawdown\nMesin filling: I\nKetebalan: 8.30\nTekanan: 2.90\nVacuum: -0.50\nKeterangan: Kondisi bagus',
    message_type: 'chat',
  };
}

async function unavailablePort(): Promise<number> {
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const closing = Promise.withResolvers<void>();
  server.close((error) => error ? closing.reject(error) : closing.resolve());
  await closing.promise;
  return port;
}

async function duplicateAuthorization(url: string, token: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const req = request(url, { headers: ['Authorization', token, 'Authorization', token] }, (res) => {
    res.resume();
    res.once('end', () => resolve(res.statusCode ?? 0));
  });
  req.once('error', reject);
  req.end();
  return promise;
}

test('API help does not require secret files or network services', () => {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.endsWith('_FILE') || key.startsWith('PG') || key.startsWith('REDIS_')) delete environment[key];
  }
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/api.ts', '--help'], {
    cwd: new URL('..', import.meta.url), env: environment, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Pemakaian: node dist\/api\.js/);
  assert.equal(result.stderr, '');
});

test('read API and protected board over real HTTP and isolated stores', { timeout: 120_000 }, async (t) => {
  const context = await createIntegrationContext('api');
  const app = await createApi(context.apiConfig, { database: context.readerDatabase, queue: context.queue });
  t.after(async () => {
    await app.close();
    await context.close();
  });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const authorization = `Bearer ${context.apiConfig.apiReadToken}`;
  const basic = `Basic ${Buffer.from(`${context.apiConfig.opsUser}:${context.apiConfig.opsPassword}`).toString('base64')}`;

  await t.test('authentication precedes validation on every v1 route', async () => {
    for (const path of ['/v1/checklists?limit=oops', '/v1/staging', '/v1/staging/summary', '/v1/monitoring', '/v1/unknown']) {
      for (const credential of ['', 'Bearer wrong', basic]) {
        const headers: Record<string, string> = {};
        if (credential) headers.authorization = credential;
        const response = await fetch(base + path, { headers });
        assert.equal(response.status, 401);
      }
    }
    assert.equal(await duplicateAuthorization(base + '/v1/checklists', authorization), 401);
  });

  await t.test('rejects invalid and duplicate query parameters rather than coercing them', async () => {
    for (const query of ['limit=0', 'limit=501', 'limit=-1', 'limit=1.5', 'limit=1e2', 'limit=', 'limit=1&limit=2', 'offset=-1', 'offset=9007199254740992', 'offset=9007199254740991&limit=2', 'view=other', 'state=active', 'machine=', 'extra=value']) {
      const response = await fetch(`${base}/v1/checklists?${query}`, { headers: { authorization } });
      assert.equal(response.status, 400, query);
      assert.equal((await response.json()).error.code, 'INVALID_QUERY');
    }
    for (const path of ['/v1/checklists?view=staging&state=unknown', '/v1/checklists?view=staging&machine=I', '/v1/staging?state=waiting&state=failed', '/v1/monitoring?view=staging', '/v1/staging/summary?limit=1']) {
      const response = await fetch(base + path, { headers: { authorization } });
      assert.equal(response.status, 400, path);
    }
  });

  await t.test('paging rejects encoded line terminators on every paginated route', async () => {
    for (const path of ['/v1/checklists?', '/v1/checklists?view=staging&', '/v1/staging?', '/v1/monitoring?']) {
      for (const parameter of ['limit=1', 'offset=0']) {
        for (const suffix of ['%0A', '%0D', '%0D%0A', '%E2%80%A8', '%E2%80%A9']) {
          const response = await fetch(base + path + parameter + suffix, { headers: { authorization } });
          assert.equal(response.status, 400, path + parameter + suffix);
          assert.equal((await response.json()).error.code, 'INVALID_QUERY');
        }
      }
    }
  });

  await t.test('empty results are successful and health is truthful', async () => {
    for (const path of ['/v1/checklists', '/v1/checklists?view=final', '/v1/checklists?view=staging']) {
      const response = await fetch(base + path, { headers: { authorization, origin: 'https://example.invalid' } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), []);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
    for (const path of ['/v1/staging', '/v1/monitoring']) {
      const response = await fetch(base + path, { headers: { authorization } });
      assert.deepEqual(await response.json(), { items: [], total: 0, limit: 100, offset: 0 });
    }
    const health = await fetch(base + '/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { redis: 'ok', postgresql: 'ok' });
    const summary = await fetch(base + '/v1/staging/summary', { headers: { authorization } });
    assert.deepEqual(await summary.json(), { queue_counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 }, reports_accepted: 0 });
  });

  const accepted = message(context.sessionKey, 'accepted-before-ack');
  const received = message(context.sessionKey, 'received');
  const queued = message(context.sessionKey, 'queued');
  const acceptedId = await enqueueMessage(accepted, context.queue);
  await enqueueMessage(received, context.queue);
  await enqueueMessage(queued, context.queue);
  const queuedJob = await context.queue.getJob(getJobId(queued));
  assert.ok(queuedJob);
  await queuedJob.updateData({ message: queued, parsed });
  await context.database.saveReport(accepted, parsed);

  await t.test('SQL commit wins before Redis acknowledgment; dashboard has exactly ten columns', async () => {
    const response = await fetch(base + '/v1/checklists?view=staging', { headers: { authorization } });
    assert.equal(response.status, 200);
    const rows = await response.json();
    assert.equal(rows.length, 3);
    for (const row of rows) assert.deepEqual(Object.keys(row), columns);
    assert.deepEqual(rows.map((row: { message_id: string; status: string }) => [row.message_id, row.status]).sort(), [
      ['accepted-before-ack', 'accepted'], ['queued', 'queued'], ['received', 'received'],
    ]);
    const details = await fetch(base + '/v1/staging?state=waiting&limit=2&offset=0', { headers: { authorization } });
    const page = await details.json();
    assert.equal(page.items.length, 2);
    assert.equal(page.total, 3);
    assert.equal(page.limit, 2);
    assert.equal(page.offset, 0);
    const allDetails = await (await fetch(base + '/v1/staging', { headers: { authorization } })).json();
    const committed = allDetails.items.find((item: { job_id: string }) => item.job_id === acceptedId);
    assert.ok(committed);
    assert.equal(committed.status, 'accepted');
    assert.equal(committed.native_state, 'waiting');
    assert.deepEqual(committed.message, accepted);
    assert.equal(committed.result, null);
    assert.equal(committed.failed_reason, null);
    const waiting = rows.find((row: { message_id: string }) => row.message_id === 'received');
    assert.equal(waiting.thickness, null);
    assert.equal(waiting.machine, null);
  });

  await t.test('final filtering, numeric boundary, timestamp and stable paging use SQL', async () => {
    const second = message(context.sessionKey, 'second-final');
    await context.database.saveReport(second, { ...parsed, machine: 'G' });
    const final = await fetch(base + '/v1/checklists?machine=I', { headers: { authorization } });
    assert.deepEqual(await final.json(), [{
      message_id: accepted.message_id, timestamp: '1800000000', chat_id: accepted.chat_id,
      sender_id: null, machine: 'I', thickness: 8.3, pressure: 2.9, vacuum: -0.5,
      notes: 'Kondisi bagus', status: 'accepted',
    }]);
    const envelope = await (await fetch(base + '/v1/monitoring?limit=1&offset=1', { headers: { authorization } })).json();
    assert.equal(envelope.total, 2);
    assert.equal(envelope.items.length, 1);
    const expected = [getJobId(accepted), getJobId(second)].sort().reverse()[1];
    assert.equal(getJobId(message(context.sessionKey, envelope.items[0].message_id)), expected);
    const none = await fetch(base + '/v1/monitoring?machine=i', { headers: { authorization } });
    assert.deepEqual(await none.json(), { items: [], total: 0, limit: 100, offset: 0 });
    const summary = await (await fetch(base + '/v1/staging/summary', { headers: { authorization } })).json();
    assert.equal(summary.reports_accepted, 2);
    assert.equal(summary.queue_counts.waiting, 3);
  });

  await t.test('waiting paging includes paused-list records while summary counts remain native', async () => {
    await context.queue.pause();
    try {
      const idsByState: string[][] = [];
      for (const state of ['waiting', 'paused']) {
        const ids: string[] = [];
        for (let offset = 0; offset <= 3; offset += 1) {
          const response = await fetch(`${base}/v1/staging?state=${state}&limit=1&offset=${offset}`, { headers: { authorization } });
          assert.equal(response.status, 200);
          const page = await response.json();
          assert.equal(page.total, 3);
          assert.equal(page.limit, 1);
          assert.equal(page.offset, offset);
          assert.equal(page.items.length, offset < 3 ? 1 : 0);
          for (const item of page.items) ids.push(item.job_id);
        }
        assert.deepEqual([...ids].sort(), [acceptedId, getJobId(received), getJobId(queued)].sort());
        idsByState.push(ids);
      }
      assert.deepEqual(idsByState[0], idsByState[1]);
      const summary = await (await fetch(base + '/v1/staging/summary', { headers: { authorization } })).json();
      assert.equal(summary.queue_counts.waiting, 0);
      assert.equal(summary.queue_counts.paused, 3);
      assert.equal(summary.reports_accepted, 2);
    } finally {
      await context.queue.resume();
    }
    const resumed = await (await fetch(base + '/v1/staging', { headers: { authorization } })).json();
    assert.equal(resumed.total, 3);
    assert.equal(resumed.items.length, 3);
  });

  await t.test('all supported native states can be read with bounded paging', async () => {
    for (const state of ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused']) {
      const response = await fetch(`${base}/v1/staging?state=${state}&limit=1&offset=0`, { headers: { authorization } });
      assert.equal(response.status, 200, state);
      assert.ok((await response.json()).items.length <= 1);
    }
  });

  await t.test('SQL truth, invalid results and native failures follow status precedence', async () => {
    const worker = new Worker<JobData, JobResult, 'checklist'>(QUEUE_NAME, undefined, {
      connection: { ...context.redisOptions, maxRetriesPerRequest: null }, autorun: false,
    });
    const workerErrors: Error[] = [];
    worker.on('error', (error) => { workerErrors.push(error); });
    try {
      await worker.waitUntilReady();
      for (let index = 0; index < 3; index += 1) {
        const token = `api-status-${index}`;
        const job = await worker.getNextJob(token, { block: false });
        assert.ok(job);
        const active = await (await fetch(base + '/v1/staging?state=active', { headers: { authorization } })).json();
        assert.equal(active.items[0].native_state, 'active');
        let expectedStatus = job.data.parsed ? 'queued' : 'received';
        if (job.id === acceptedId) expectedStatus = 'accepted';
        assert.equal(active.items[0].status, expectedStatus);
        if (job.data.message.message_id === 'received') {
          await job.moveToCompleted({ status: 'invalid', errors: [{ field: 'pesan', code: 'INVALID_HEADER', message: 'Judul tidak valid' }] }, token, false);
        } else {
          await job.moveToFailed(new Error('Kegagalan teknis pengujian'), token, false);
        }
      }
      const failed = await (await fetch(base + '/v1/staging?state=failed', { headers: { authorization } })).json();
      assert.equal(failed.total, 2);
      assert.deepEqual(failed.items.map((item: { job_id: string; status: string }) => [item.job_id, item.status]).sort(), [
        [acceptedId, 'accepted'], [getJobId(queued), 'failed'],
      ].sort());
      const invalid = await (await fetch(base + '/v1/checklists?view=staging&state=completed', { headers: { authorization } })).json();
      assert.equal(invalid[0].status, 'invalid');
      assert.equal(invalid[0].pressure, null);
      const client = await context.queue.client;
      const invalidResult = JSON.stringify({ status: 'invalid', errors: [{ field: 'pesan', code: 'INVALID_HEADER', message: 'Judul tidak valid' }] });
      await client.hset(context.queue.toKey(acceptedId), 'returnvalue', invalidResult);
      await client.hset(context.queue.toKey(getJobId(queued)), 'returnvalue', invalidResult);
      const precedence = await (await fetch(base + '/v1/staging?state=failed', { headers: { authorization } })).json();
      assert.deepEqual(precedence.items.map((item: { job_id: string; status: string }) => [item.job_id, item.status]).sort(), [
        [acceptedId, 'accepted'], [getJobId(queued), 'invalid'],
      ].sort());
    } finally {
      await worker.close();
    }
    assert.deepEqual(workerErrors, []);
  });

  await t.test('persisted malformed fields are not projected as valid or leaked through errors', async () => {
    const sample = message(context.sessionKey, 'malformed-parsed');
    const id = await enqueueMessage(sample, context.queue);
    const job = await context.queue.getJob(id);
    assert.ok(job);
    await job.updateData({ message: sample, parsed: { ...parsed, thickness: 'Infinity' } });
    const response = await fetch(base + '/v1/checklists?view=staging', { headers: { authorization } });
    const rows = await response.json();
    assert.equal(rows[0].status, 'received');
    assert.equal(rows[0].thickness, null);
    const client = await context.queue.client;
    await client.hset(context.queue.toKey(id), 'returnvalue', JSON.stringify({ status: 'accepted', job_id: id }));
    const uncommitted = await (await fetch(base + '/v1/staging', { headers: { authorization } })).json();
    assert.equal(uncommitted.items[0].status, 'received');
    await client.hset(context.queue.toKey(id), 'data', JSON.stringify({ message: { raw_body: 'private malformed data' } }));
    const malformed = await fetch(base + '/v1/staging', { headers: { authorization } });
    assert.equal(malformed.status, 500);
    assert.deepEqual(await malformed.json(), { error: { code: 'INTERNAL_ERROR', message: 'Kesalahan internal layanan' } });
    await client.hset(context.queue.toKey(id), 'data', '{private malformed data');
    const boardMalformed = await fetch(`${base}/ops/queues/api/queues/${QUEUE_NAME}/${id}`, { headers: { authorization: basic } });
    assert.equal(boardMalformed.status, 500);
    assert.deepEqual(await boardMalformed.json(), { error: { code: 'INTERNAL_ERROR', message: 'Kesalahan internal layanan' } });
    await job.remove();
  });

  await t.test('board protects HTML, a real asset, JSON and mutations before body parsing', async () => {
    const html = await fetch(base + '/ops/queues/', { headers: { authorization: basic } });
    assert.equal(html.status, 200);
    const content = await html.text();
    const asset = /(?:src|href)="([^"]*\/static\/[^\"]+)"/.exec(content)?.[1];
    assert.ok(asset, 'installed board HTML must reference a static asset');
    for (const path of ['/ops/queues', '/ops/queues/', asset, '/ops/queues/api/queues']) {
      for (const credential of ['', authorization, `Basic ${Buffer.from('operator:wrong').toString('base64')}`]) {
        const response = await fetch(new URL(path, base), { headers: credential ? { authorization: credential } : {} });
        assert.equal(response.status, 401, path);
        assert.match(response.headers.get('www-authenticate') ?? '', /^Basic /);
      }
      assert.equal((await fetch(new URL(path, base), { headers: { authorization: basic } })).status, 200, path);
    }
    const routes = [
      ['POST', `/ops/queues/api/queues/${QUEUE_NAME}/add`],
      ['PUT', `/ops/queues/api/queues/${QUEUE_NAME}/pause`],
      ['PUT', `/ops/queues/api/queues/${QUEUE_NAME}/${acceptedId}/retry`],
      ['PUT', '/ops/queues/api/queues/pause'],
      ['PATCH', `/ops/queues/api/queues/${QUEUE_NAME}/job-schedulers/test`],
      ['DELETE', `/ops/queues/api/queues/${QUEUE_NAME}/${acceptedId}`],
    ];
    for (const [method, path] of routes) {
      assert.ok(method && path);
      for (const credential of ['', authorization, basic]) {
        const response = await fetch(base + path, {
          method, headers: { authorization: credential, 'content-type': 'application/json' }, body: '{invalid json',
        });
        assert.equal(response.status, credential === basic ? 405 : 401, `${method} ${path}`);
      }
    }
    assert.equal(await context.queue.isPaused(), false);
    assert.equal(await duplicateAuthorization(base + '/ops/queues/api/queues', basic), 401);
  });

  await t.test('Redis outage does not block startup or SQL-only reads', async () => {
    const queue = createQueue({ ...context.redisOptions, host: '127.0.0.1', port: await unavailablePort(), retryStrategy: () => null, connectTimeout: 100 });
    const offline = await createApi(context.apiConfig, { database: context.readerDatabase, queue });
    try {
      const url = await offline.listen({ host: '127.0.0.1', port: 0 });
      for (const path of ['/v1/checklists', '/v1/checklists?view=final', '/v1/monitoring']) {
        assert.equal((await fetch(url + path, { headers: { authorization } })).status, 200, path);
      }
      for (const path of ['/v1/staging', '/v1/staging/summary', '/v1/checklists?view=staging']) {
        const response = await fetch(url + path, { headers: { authorization } });
        assert.equal(response.status, 503, path);
        const error = (await response.json()).error;
        assert.equal(error.code, 'DEPENDENCY_UNAVAILABLE');
        assert.match(error.message, /Redis/);
        assert.ok(!JSON.stringify(error).includes(context.apiConfig.redis.password));
      }
      const boardPath = '/ops/queues/api/queues';
      assert.equal((await fetch(url + boardPath)).status, 401);
      assert.equal((await fetch(url + boardPath, { headers: { authorization } })).status, 401);
      const boardResponse = await fetch(url + boardPath, { headers: { authorization: basic } });
      assert.equal(boardResponse.status, 503);
      assert.deepEqual(await boardResponse.json(), {
        error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Redis tidak tersedia' },
      });
      const health = await fetch(url + '/healthz');
      assert.equal(health.status, 503);
      assert.deepEqual(await health.json(), { redis: 'unavailable', postgresql: 'ok' });
    } finally {
      await offline.close();
      await queue.close();
    }
  });

  await t.test('SQL outage is 503 for final and staging, never empty or guessed status', async () => {
    const database = createDatabase({ ...context.apiConfig.database, host: '127.0.0.1', port: await unavailablePort(), connectionTimeoutMillis: 100 });
    const offline = await createApi(context.apiConfig, { database, queue: context.queue });
    try {
      const url = await offline.listen({ host: '127.0.0.1', port: 0 });
      for (const path of ['/v1/checklists', '/v1/monitoring', '/v1/staging', '/v1/staging?state=failed', '/v1/staging/summary', '/v1/checklists?view=staging']) {
        const response = await fetch(url + path, { headers: { authorization } });
        assert.equal(response.status, 503, path);
        const error = (await response.json()).error;
        assert.equal(error.code, 'DEPENDENCY_UNAVAILABLE');
        assert.match(error.message, /PostgreSQL/);
        assert.ok(!JSON.stringify(error).includes(context.apiConfig.database.password));
      }
      const health = await fetch(url + '/healthz');
      assert.equal(health.status, 503);
      assert.deepEqual(await health.json(), { redis: 'ok', postgresql: 'unavailable' });
    } finally {
      await offline.close();
      await database.close();
    }
  });
});

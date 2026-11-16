import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import basicAuth from '@fastify/basic-auth';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { ConnectionClosedError } from 'bullmq';
import { MaxRetriesPerRequestError } from 'ioredis/built/errors/index.js';
import { loadConfig, type ServiceConfig } from './config.js';
import { createDatabase, type Database, type FinalRecord } from './database.js';
import { createQueue, type ChecklistQueue } from './queue.js';
import type { DashboardRow, IncomingMessage, JobResult, ParsedChecklist, ValidationError } from './types.js';

type ApiConfig = Extract<ServiceConfig, { service: 'api' }>;
type NativeState = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused';
type PageQuery = { limit: number; offset: number; machine?: string; state: NativeState; view: 'final' | 'staging' };
type StagingItem = {
  job_id: string;
  native_state: NativeState;
  status: DashboardRow['status'];
  message: IncomingMessage;
  parsed: ParsedChecklist | null;
  result: JobResult | null;
  failed_reason: string | null;
};
type ErrorResponse = { status: number; body: { error: { code: string; message: string } } };

const STATES: NativeState[] = ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'];
const VALIDATION_CODES: Record<ValidationError['code'], true> = {
  INVALID_HEADER: true, MALFORMED_LINE: true, UNKNOWN_FIELD: true, DUPLICATE_FIELD: true,
  MISSING_FIELD: true, EMPTY_FIELD: true, INVALID_DECIMAL: true,
};

function isState(value: unknown): value is NativeState {
  return value === 'waiting' || value === 'active' || value === 'completed'
    || value === 'failed' || value === 'delayed' || value === 'paused';
}

function invalidQuery(message: string): never {
  throw Object.assign(new Error(message), { code: 'INVALID_QUERY' });
}

function parseQuery(url: string, route: 'checklists' | 'staging' | 'monitoring' | 'summary'): PageQuery {
  const separator = url.indexOf('?');
  const input = new URLSearchParams(separator < 0 ? '' : url.slice(separator + 1));
  const allowed = new Set(route === 'summary' ? [] : ['limit', 'offset']);
  if (route === 'checklists') allowed.add('view');
  if (route === 'checklists' || route === 'monitoring') allowed.add('machine');
  if (route === 'checklists' || route === 'staging') allowed.add('state');
  for (const key of input.keys()) {
    if (!allowed.has(key) || input.getAll(key).length !== 1) invalidQuery('Parameter query tidak dikenal atau berulang');
  }
  const view = input.get('view') ?? (route === 'staging' ? 'staging' : 'final');
  if (view !== 'final' && view !== 'staging') invalidQuery('view harus final atau staging');
  if (view === 'final' && input.has('state')) invalidQuery('state hanya untuk view staging');
  if (view === 'staging' && input.has('machine')) invalidQuery('machine hanya untuk view final');
  const state = input.get('state') ?? 'waiting';
  if (!isState(state)) invalidQuery('state BullMQ tidak didukung');
  const limit = parseInteger(input.get('limit') ?? undefined, 100, 1, 500, 'limit');
  const offset = parseInteger(input.get('offset') ?? undefined, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
  if (offset > Number.MAX_SAFE_INTEGER - (limit - 1)) invalidQuery('Rentang paging terlalu besar');
  const result: PageQuery = { limit, offset, view, state };
  const machine = input.get('machine');
  if (machine !== null) {
    if (machine.trim() === '' || machine.includes('\0')) invalidQuery('machine harus string tidak kosong');
    result.machine = machine;
  }
  return result;
}

function parseInteger(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length === 0 || /[^0-9]/.test(value)) invalidQuery(`${name} harus integer desimal`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) invalidQuery(`${name} di luar rentang`);
  return number;
}

function credentialsEqual(actual: string, expected: string): boolean {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function singleAuthorization(request: FastifyRequest): string | undefined {
  let count = 0;
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === 'authorization') count += 1;
  }
  const header = request.headers.authorization;
  return count === 1 && typeof header === 'string' ? header : undefined;
}

function errorResponse(error: unknown): ErrorResponse {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  if (code === 'INVALID_QUERY' && error instanceof Error) {
    return { status: 400, body: { error: { code, message: error.message } } };
  }
  if (code === 'DATABASE_UNAVAILABLE' || code === 'REDIS_UNAVAILABLE') {
    return {
      status: 503,
      body: { error: { code: 'DEPENDENCY_UNAVAILABLE', message: `${code === 'DATABASE_UNAVAILABLE' ? 'PostgreSQL' : 'Redis'} tidak tersedia` } },
    };
  }
  if (error instanceof Error && 'statusCode' in error && error.statusCode === 401) {
    return { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Autentikasi diperlukan' } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Kesalahan internal layanan' } } };
}

function sendError(error: unknown, _request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const response = errorResponse(error);
  return reply.code(response.status).send(response.body);
}

function isRedisConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof ConnectionClosedError || error instanceof MaxRetriesPerRequestError) return true;
  if ('code' in error) {
    switch (error.code) {
      case 'ECONNREFUSED':
      case 'ECONNRESET':
      case 'EPIPE':
      case 'ETIMEDOUT':
      case 'ENETUNREACH':
      case 'EHOSTUNREACH':
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return true;
    }
  }
  return error.message === 'Connection is closed.'
    || error.message === "Stream isn't writeable and enableOfflineQueue options is false"
    || error.message === 'Command timed out';
}

async function readRedis<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw Object.assign(new Error('Redis tidak tersedia'), { code: 'REDIS_UNAVAILABLE' });
  }
}

function validDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(value)
    && Number.isFinite(Number(value)) && (Number(value) !== 0 || !/[1-9]/.test(value));
}

function validParsed(value: unknown): value is ParsedChecklist {
  return typeof value === 'object' && value !== null
    && 'machine' in value && typeof value.machine === 'string' && value.machine.trim() !== ''
    && 'notes' in value && typeof value.notes === 'string' && value.notes.trim() !== ''
    && 'thickness' in value && validDecimal(value.thickness)
    && 'pressure' in value && validDecimal(value.pressure)
    && 'vacuum' in value && validDecimal(value.vacuum);
}

function validMessage(value: unknown): value is IncomingMessage {
  return typeof value === 'object' && value !== null
    && 'session_key' in value && typeof value.session_key === 'string' && value.session_key !== ''
    && 'message_id' in value && typeof value.message_id === 'string' && value.message_id !== ''
    && 'source_timestamp' in value && typeof value.source_timestamp === 'number' && Number.isSafeInteger(value.source_timestamp) && value.source_timestamp >= 0
    && 'chat_id' in value && typeof value.chat_id === 'string' && value.chat_id !== ''
    && 'sender_id' in value && (value.sender_id === null || typeof value.sender_id === 'string')
    && 'received_at' in value && typeof value.received_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.received_at)
    && Number.isFinite(Date.parse(value.received_at))
    && 'raw_body' in value && typeof value.raw_body === 'string'
    && 'message_type' in value && typeof value.message_type === 'string';
}

function validValidationError(value: unknown): value is ValidationError {
  return typeof value === 'object' && value !== null
    && 'field' in value && typeof value.field === 'string'
    && 'message' in value && typeof value.message === 'string'
    && 'code' in value && typeof value.code === 'string' && Object.hasOwn(VALIDATION_CODES, value.code);
}

function decodeResult(value: unknown): JobResult | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && 'status' in value && value.status === 'accepted' && 'job_id' in value && typeof value.job_id === 'string') {
    return { status: 'accepted', job_id: value.job_id };
  }
  if (typeof value === 'object' && 'status' in value && value.status === 'invalid' && 'errors' in value && Array.isArray(value.errors) && value.errors.every(validValidationError)) {
    return { status: 'invalid', errors: value.errors };
  }
  throw new Error('Hasil staging tidak valid');
}

function dashboardRow(message: IncomingMessage | FinalRecord, parsed: ParsedChecklist | null, status: DashboardRow['status']): DashboardRow {
  return {
    message_id: message.message_id,
    timestamp: String(message.source_timestamp),
    chat_id: message.chat_id,
    sender_id: message.sender_id,
    machine: parsed?.machine ?? null,
    thickness: parsed ? Number(parsed.thickness) : null,
    pressure: parsed ? Number(parsed.pressure) : null,
    vacuum: parsed ? Number(parsed.vacuum) : null,
    notes: parsed?.notes ?? null,
    status,
  };
}

function finalRow(record: FinalRecord): DashboardRow {
  if (!validParsed(record)) throw new Error('Record final tidak valid');
  return dashboardRow(record, record, 'accepted');
}

async function queueCounts(queue: ChecklistQueue): Promise<Record<NativeState, number>> {
  const counts = await readRedis(() => queue.getJobCounts(...STATES));
  return {
    waiting: counts.waiting ?? counts.wait ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
    paused: counts.paused ?? 0,
  };
}

async function stagingPage(queue: ChecklistQueue, database: Database, query: PageQuery): Promise<{ items: StagingItem[]; rows: DashboardRow[] }> {
  const jobs = await readRedis(() => queue.getJobs([query.state], query.offset, query.offset + query.limit - 1, false));
  const page: { job: NonNullable<typeof jobs[number]>; state: NativeState; id: string }[] = [];
  for (const job of jobs) {
    if (!job || !job.id) continue;
    const state = await readRedis(() => job.getState());
    if (state === 'unknown') continue;
    if (!isState(state)) throw new Error('State staging tidak didukung');
    page.push({ job, state, id: job.id });
  }
  const finalRecords = await database.findReportsByJobIds(page.map(({ id }) => id));
  if (page.length === 0) await database.ping();
  const items: StagingItem[] = [];
  const rows: DashboardRow[] = [];
  for (const { job, state, id } of page) {
    const data: unknown = job.data;
    if (typeof data !== 'object' || data === null || !('message' in data) || !validMessage(data.message)) {
      throw new Error('Metadata staging tidak valid');
    }
    const parsed = 'parsed' in data && validParsed(data.parsed) ? data.parsed : null;
    const result = decodeResult(job.returnvalue);
    const final = finalRecords.get(id);
    let status: DashboardRow['status'] = 'received';
    if (final) status = 'accepted';
    else if (result?.status === 'invalid') status = 'invalid';
    else if (state === 'failed') status = 'failed';
    else if (parsed) status = 'queued';
    items.push({
      job_id: id, native_state: state, status, message: data.message, parsed, result,
      failed_reason: typeof job.failedReason === 'string' && job.failedReason !== '' ? job.failedReason : null,
    });
    rows.push(final ? finalRow(final) : dashboardRow(data.message, parsed, status));
  }
  return { items, rows };
}

export async function createApi(config?: ApiConfig, dependencies?: { database: Database; queue: ChecklistQueue }): Promise<FastifyInstance> {
  const resolved = config ?? loadConfig('api');
  if (resolved.service !== 'api') throw new Error('Konfigurasi API tidak valid');
  const database = dependencies?.database ?? createDatabase({ ...resolved.database, connectionTimeoutMillis: 5_000 });
  const queue = dependencies?.queue ?? createQueue(resolved.redis);
  const app = Fastify({ logger: false });
  app.setErrorHandler(sendError);
  app.addHook('onClose', async () => {
    if (!dependencies) {
      const closed = await Promise.allSettled([queue.close(), database.close()]);
      if (closed.some((result) => result.status === 'rejected')) throw new Error('Penutupan koneksi API gagal');
    }
  });
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (path === '/v1' || path.startsWith('/v1/') || request.routeOptions.url?.startsWith('/v1/')) {
      const header = singleAuthorization(request);
      const match = typeof header === 'string' ? /^Bearer ([^\s]+)$/i.exec(header) : null;
      if (!match?.[1] || !credentialsEqual(match[1], resolved.apiReadToken)) {
        return reply.header('www-authenticate', 'Bearer').code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Autentikasi diperlukan' } });
      }
    }
  });

  app.get('/v1/checklists', async (request) => {
    const query = parseQuery(request.url, 'checklists');
    if (query.view === 'final') return (await database.listReports(query)).map(finalRow);
    return (await stagingPage(queue, database, query)).rows;
  });
  app.get('/v1/monitoring', async (request) => {
    const query = parseQuery(request.url, 'monitoring');
    const records = await database.listReports(query);
    const total = await database.countReports(query.machine);
    return { items: records.map(finalRow), total, limit: query.limit, offset: query.offset };
  });
  app.get('/v1/staging', async (request) => {
    const query = parseQuery(request.url, 'staging');
    const page = await stagingPage(queue, database, query);
    const counts = await queueCounts(queue);
    const total = query.state === 'waiting' ? counts.waiting + counts.paused : counts[query.state];
    return { items: page.items, total, limit: query.limit, offset: query.offset };
  });
  app.get('/v1/staging/summary', async (request) => {
    parseQuery(request.url, 'summary');
    const counts = await queueCounts(queue);
    const accepted = await database.countReports();
    return { queue_counts: counts, reports_accepted: accepted };
  });
  app.get('/healthz', async (_request, reply) => {
    const [redis, postgresql] = await Promise.allSettled([
      readRedis(async () => (await queue.client).ping()), database.ping(),
    ]);
    return reply.code(redis.status === 'fulfilled' && postgresql.status === 'fulfilled' ? 200 : 503).send({
      redis: redis.status === 'fulfilled' ? 'ok' : 'unavailable',
      postgresql: postgresql.status === 'fulfilled' ? 'ok' : 'unavailable',
    });
  });

  app.register(async function boardScope(board) {
    board.addHook('onRoute', (options) => {
      options.errorHandler = (error, request, reply) => {
        if (isRedisConnectionError(error)) {
          return sendError(Object.assign(new Error('Redis tidak tersedia'), { code: 'REDIS_UNAVAILABLE' }), request, reply);
        }
        return sendError(error, request, reply);
      };
    });
    await board.register(basicAuth, {
      authenticate: { realm: 'Monitoring queues' },
      async validate(username, password) {
        const validUser = credentialsEqual(username, resolved.opsUser);
        const validPassword = credentialsEqual(password, resolved.opsPassword);
        if (!validUser || !validPassword) throw new Error('Autentikasi diperlukan');
      },
    });
    board.addHook('onRequest', async (request, reply) => {
      if (singleAuthorization(request) === undefined) {
        return reply.header('www-authenticate', 'Basic realm="Monitoring queues"').code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Autentikasi diperlukan' } });
      }
    });
    board.addHook('onRequest', board.basicAuth);
    board.addHook('onRequest', async (request, reply) => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        return reply.header('allow', 'GET, HEAD, OPTIONS').code(405).send({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Bull Board hanya baca' } });
      }
    });
    const adapter = new FastifyAdapter();
    adapter.setBasePath('/ops/queues');
    createBullBoard({ queues: [new BullMQAdapter(queue, { readOnlyMode: true })], serverAdapter: adapter });
    board.register(adapter.registerPlugin(), { prefix: '/ops/queues' });
    board.all('/ops/queues/*', async (_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Rute tidak ditemukan' } }));
    board.route({
      method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      url: '/ops/queues',
      handler: async (_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Rute tidak ditemukan' } }),
    });
  });
  try {
    await app.ready();
    return app;
  } catch {
    await app.close();
    throw new Error('Inisialisasi API gagal');
  }
}

if (import.meta.main) {
  if (process.argv.includes('--help')) {
    console.log('API monitoring WhatsApp\nPemakaian: node dist/api.js [--help]\nMendengarkan 0.0.0.0:3000; konfigurasi melalui environment dan secret file.');
  } else {
    try {
      const app = await createApi();
      try {
        await app.listen({ host: '0.0.0.0', port: 3000 });
      } catch {
        await app.close();
        throw new Error('API tidak dapat mendengarkan');
      }
      let closing = false;
      async function shutdown(): Promise<void> {
        if (closing) return;
        closing = true;
        try {
          await app.close();
        } catch {
          console.error('Penutupan API gagal');
          process.exitCode = 1;
        }
      }
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    } catch {
      console.error('API gagal dimulai');
      process.exitCode = 1;
    }
  }
}

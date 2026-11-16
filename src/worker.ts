import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import type { ServiceConfig } from './config.js';
import { createDatabase, findReport, saveReport } from './database.js';
import type { Database } from './database.js';
import { parseChecklist } from './parser.js';
import { QUEUE_NAME, getJobId } from './queue.js';
import type { JobData, JobResult } from './types.js';

export type WorkerHandle = {
  worker: Worker<JobData, JobResult, 'checklist'>;
  close: () => Promise<void>;
};

export async function processChecklist(
  job: Job<JobData, JobResult, 'checklist'>,
  database?: Database,
): Promise<JobResult> {
  try {
    const message = job.data.message;
    const existing = await (database ? database.findReport(message) : findReport(message));
    if (existing) { return { status: 'accepted', job_id: existing.job_id }; }
    const parsed = parseChecklist(message.raw_body);
    if (!parsed.ok) { return { status: 'invalid', errors: parsed.errors }; }
    await job.updateData({ ...job.data, parsed: parsed.value });
    await (database ? database.saveReport(message, parsed.value) : saveReport(message, parsed.value));
    return { status: 'accepted', job_id: getJobId(message) };
  } catch {
    throw Object.assign(new Error('Pemrosesan checklist gagal'), { code: 'PROCESSING_FAILED' });
  }
}

export async function startWorker(
  config?: Extract<ServiceConfig, { service: 'worker' }>,
): Promise<WorkerHandle> {
  const settings = config ?? loadConfig('worker');
  if (settings.service !== 'worker') { throw new Error('Konfigurasi worker tidak valid'); }
  const database = createDatabase(settings.database);
  const connection = new Redis({ ...settings.redis, maxRetriesPerRequest: null });
  connection.on('error', () => { console.error('Redis tidak tersedia'); });
  let worker: Worker<JobData, JobResult, 'checklist'> | undefined;
  let closing: Promise<void> | undefined;

  async function closeResources(): Promise<void> {
    try {
      if (worker) { await worker.close(); }
    } finally {
      try { await database.close(); }
      finally { connection.disconnect(); }
    }
  }

  try {
    worker = new Worker<JobData, JobResult, 'checklist'>(QUEUE_NAME,
      async function processJob(job) { return processChecklist(job, database); }, {
        connection,
        concurrency: 1,
        lockDuration: 30_000,
        stalledInterval: 30_000,
        maxStalledCount: 1,
      });
    worker.on('error', () => { console.error('Worker tidak dapat mengakses antrean'); });
    worker.on('failed', () => { console.error('Pemrosesan checklist gagal'); });
    await worker.waitUntilReady();
    return {
      worker,
      close() {
        closing ??= closeResources();
        return closing;
      },
    };
  } catch {
    await closeResources();
    throw new Error('Worker tidak dapat dimulai');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Penggunaan: node dist/worker.js [--help]\nMemproses checklist dari Redis ke PostgreSQL.');
    return;
  }
  if (args.length !== 0) { throw new Error('Argumen worker tidak valid'); }
  const handle = await startWorker();
  function shutdown(): void {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    void handle.close().catch(() => {
      console.error('Worker gagal ditutup');
      process.exitCode = 1;
    });
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (import.meta.main) {
  void main().catch(() => {
    console.error('Worker gagal dijalankan');
    process.exitCode = 1;
  });
}

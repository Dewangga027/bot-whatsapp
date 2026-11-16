import { once } from 'node:events';
import { loadConfig } from './config.js';
import { createQueue } from './queue.js';
import type { ChecklistQueue } from './queue.js';

export async function retryFailedJob(jobId: string, queue?: ChecklistQueue): Promise<void> {
  if (typeof jobId !== 'string' || jobId.length === 0) {
    throw Object.assign(new Error('ID job wajib diisi'), { code: 'INVALID_JOB_ID' });
  }
  let ownedQueue: ChecklistQueue | undefined;
  try {
    if (!queue) {
      const config = loadConfig('ops');
      if (config.service !== 'ops') { throw new Error('Konfigurasi operator tidak valid'); }
      ownedQueue = createQueue(config.redis);
      queue = ownedQueue;
      const client = queue.redisClient;
      if (client.status !== 'ready') {
        if (client.status === 'end') { throw new Error('Redis tidak tersedia'); }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        function connectionClosed(): void { controller.abort(); }
        client.once('close', connectionClosed);
        client.once('end', connectionClosed);
        try { await once(client, 'ready', { signal: controller.signal }); }
        finally {
          clearTimeout(timer);
          client.removeListener('close', connectionClosed);
          client.removeListener('end', connectionClosed);
        }
      }
    }
    const job = await queue.getJob(jobId);
    if (!job) {
      throw Object.assign(new Error('Job tidak ditemukan'), { code: 'JOB_NOT_FOUND' });
    }
    if (await job.getState() !== 'failed') {
      throw Object.assign(new Error('Hanya job failed yang dapat diulang'), { code: 'NOT_FAILED' });
    }
    await job.retry('failed');
  } catch (error) {
    if (error instanceof Error && 'code' in error
      && (error.code === 'JOB_NOT_FOUND' || error.code === 'NOT_FAILED')) {
      throw error;
    }
    throw Object.assign(new Error('Retry job gagal'), { code: 'RETRY_FAILED' });
  } finally {
    if (ownedQueue) { await ownedQueue.close(); }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Penggunaan: node dist/ops.js retry <job-id>\nHanya job native failed yang boleh diulang; koreksi format dikirim sebagai pesan baru.');
    return;
  }
  if (args.length !== 2 || args[0] !== 'retry') { throw new Error('Argumen operator tidak valid'); }
  await retryFailedJob(args[1]);
  console.log('Job failed dikembalikan ke antrean');
}

if (import.meta.main) {
  void main().catch(() => {
    console.error('Perintah operator gagal');
    process.exitCode = 1;
  });
}

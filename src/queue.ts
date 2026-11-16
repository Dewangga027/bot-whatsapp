import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import { loadConfig } from './config.js';
import type { IncomingMessage, JobData, JobResult } from './types.js';

export const QUEUE_NAME = 'monitoring-drawdown';
export type ChecklistQueue = Queue<JobData, JobResult, 'checklist'>;

let defaultQueue: ChecklistQueue | undefined;

export function createQueue(settings: RedisOptions): ChecklistQueue {
  const connection = new Redis({ ...settings, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  connection.on('error', () => { console.error('Redis tidak tersedia'); });
  let queue: ChecklistQueue;
  try {
    queue = new Queue<JobData, JobResult, 'checklist'>(QUEUE_NAME, {
      connection,
      // BullMQ's initial INFO must not permanently reject a cold/offline connection.
      // Redis compatibility is fixed by the pinned deployment image instead.
      skipWaitingForReady: true,
      skipVersionCheck: true,
      defaultJobOptions: { attempts: 1, removeOnComplete: false, removeOnFail: false },
    });
  } catch (error) {
    connection.disconnect();
    throw error;
  }
  queue.on('error', () => { console.error('Redis tidak tersedia'); });
  const closeBullQueue = queue.close.bind(queue);
  let closing: Promise<void> | undefined;
  async function closeOwnedResources(): Promise<void> {
    try {
      await closeBullQueue();
      if (connection.status === 'ready') { await connection.quit(); }
    } finally {
      connection.disconnect();
    }
  }
  // The factory owns this shared client; offline QUIT cannot be relied on to close it.
  queue.close = function close(): Promise<void> {
    closing ??= closeOwnedResources();
    return closing;
  };
  return queue;
}

export function getJobId(message: IncomingMessage): string {
  return `wa-${createHash('sha256').update(JSON.stringify([message.session_key, message.message_id])).digest('hex')}`;
}

function validateMessage(message: IncomingMessage): void {
  if (message === null || typeof message !== 'object'
    || (Object.getPrototypeOf(message) !== Object.prototype && Object.getPrototypeOf(message) !== null)
    || typeof message.session_key !== 'string' || message.session_key.length === 0
    || typeof message.message_id !== 'string' || message.message_id.length === 0
    || typeof message.chat_id !== 'string' || message.chat_id.length === 0
    || typeof message.message_type !== 'string' || message.message_type.length === 0
    || typeof message.raw_body !== 'string'
    || (message.sender_id !== null && typeof message.sender_id !== 'string')
    || !Number.isSafeInteger(message.source_timestamp) || message.source_timestamp < 0
    || typeof message.received_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(message.received_at)) {
    throw Object.assign(new Error('Metadata pesan tidak valid'), { code: 'INVALID_MESSAGE' });
  }
  const parsedDate = new Date(message.received_at);
  const canonical = message.received_at.includes('.') ? message.received_at : message.received_at.replace('Z', '.000Z');
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString() !== canonical) {
    throw Object.assign(new Error('Metadata pesan tidak valid'), { code: 'INVALID_MESSAGE' });
  }
}

export async function enqueueMessage(message: IncomingMessage, queue?: ChecklistQueue): Promise<string> {
  validateMessage(message);
  const jobId = getJobId(message);
  try {
    if (!queue) {
      if (!defaultQueue) {
        const config = loadConfig('ops');
        if (config.service !== 'ops') { throw new Error('Konfigurasi antrean tidak valid'); }
        defaultQueue = createQueue(config.redis);
        const client = await defaultQueue.client;
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
      queue = defaultQueue;
    }
    await queue.add('checklist', { message, parsed: null }, {
      jobId, attempts: 1, removeOnComplete: false, removeOnFail: false,
    });
    return jobId;
  } catch {
    throw Object.assign(new Error('Pesan belum tersimpan di Redis'), { code: 'NOT_STAGED' });
  }
}

export async function closeQueue(): Promise<void> {
  const queue = defaultQueue;
  defaultQueue = undefined;
  if (queue) { await queue.close(); }
}

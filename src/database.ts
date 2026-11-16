import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { loadConfig } from './config.js';
import { getJobId } from './queue.js';
import type { IncomingMessage, ParsedChecklist } from './types.js';

export type FinalRecord = Omit<IncomingMessage, 'source_timestamp'> & ParsedChecklist & {
  job_id: string;
  source_timestamp: string;
  accepted_at: string;
};

export type ReportQuery = {
  machine?: string;
  limit: number;
  offset: number;
};

export type Database = {
  findReport(message: IncomingMessage): Promise<FinalRecord | null>;
  saveReport(message: IncomingMessage, parsed: ParsedChecklist): Promise<FinalRecord>;
  findReportsByJobIds(jobIds: string[]): Promise<Map<string, FinalRecord>>;
  listReports(query: ReportQuery): Promise<FinalRecord[]>;
  countReports(machine?: string): Promise<number>;
  ping(): Promise<void>;
  close(): Promise<void>;
};

const REPORT_COLUMNS = `job_id, session_key, message_id, source_timestamp::text,
  chat_id, sender_id,
  to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,
  raw_body, message_type, machine, thickness::text, pressure::text, vacuum::text, notes,
  to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS accepted_at`;

let defaultDatabase: Database | undefined;

function databaseUnavailable(): Error & { code: string } {
  return Object.assign(new Error('PostgreSQL tidak tersedia'), { code: 'DATABASE_UNAVAILABLE' });
}

export function createDatabase(settings: PoolConfig): Database {
  const pool = new Pool({ connectionTimeoutMillis: 5_000, ...settings });
  pool.on('error', function onPoolError() {
    console.error('PostgreSQL tidak tersedia');
  });

  async function findReport(message: IncomingMessage): Promise<FinalRecord | null> {
    try {
      const result = await pool.query<FinalRecord>(
        `SELECT ${REPORT_COLUMNS} FROM public.monitoring_drawdown
         WHERE session_key = $1 AND message_id = $2`,
        [message.session_key, message.message_id],
      );
      return result.rows[0] ?? null;
    } catch {
      throw databaseUnavailable();
    }
  }

  async function saveReport(message: IncomingMessage, parsed: ParsedChecklist): Promise<FinalRecord> {
    try {
      const client = await pool.connect();
      let discardClient = true;
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO public.monitoring_drawdown
            (job_id, session_key, message_id, source_timestamp, chat_id, sender_id,
             received_at, raw_body, message_type, machine, thickness, pressure, vacuum, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (session_key, message_id) DO NOTHING`,
          [
            getJobId(message), message.session_key, message.message_id, message.source_timestamp,
            message.chat_id, message.sender_id, message.received_at, message.raw_body,
            message.message_type, parsed.machine, parsed.thickness, parsed.pressure,
            parsed.vacuum, parsed.notes,
          ],
        );
        const result = await client.query<FinalRecord>(
          `SELECT ${REPORT_COLUMNS} FROM public.monitoring_drawdown
           WHERE session_key = $1 AND message_id = $2`,
          [message.session_key, message.message_id],
        );
        const record = result.rows[0];
        if (record === undefined) {
          throw databaseUnavailable();
        }
        await client.query('COMMIT');
        discardClient = false;
        return record;
      } catch {
        await client.query('ROLLBACK');
        throw databaseUnavailable();
      } finally {
        client.release(discardClient);
      }
    } catch {
      throw databaseUnavailable();
    }
  }

  async function findReportsByJobIds(jobIds: string[]): Promise<Map<string, FinalRecord>> {
    if (jobIds.length === 0) {
      return new Map();
    }
    try {
      const result = await pool.query<FinalRecord>(
        `SELECT ${REPORT_COLUMNS} FROM public.monitoring_drawdown WHERE job_id = ANY($1::text[])`,
        [jobIds],
      );
      return new Map(result.rows.map(function reportEntry(record): [string, FinalRecord] {
        return [record.job_id, record];
      }));
    } catch {
      throw databaseUnavailable();
    }
  }

  async function listReports(query: ReportQuery): Promise<FinalRecord[]> {
    try {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1
        || !Number.isSafeInteger(query.offset) || query.offset < 0) {
        throw databaseUnavailable();
      }
      const values: (string | number)[] = [query.limit, query.offset];
      let filter = '';
      if (query.machine !== undefined) {
        filter = 'WHERE machine = $3';
        values.push(query.machine);
      }
      const result = await pool.query<FinalRecord>(
        `SELECT ${REPORT_COLUMNS} FROM public.monitoring_drawdown ${filter}
         ORDER BY public.monitoring_drawdown.received_at DESC, job_id DESC LIMIT $1 OFFSET $2`,
        values,
      );
      return result.rows;
    } catch {
      throw databaseUnavailable();
    }
  }

  async function countReports(machine?: string): Promise<number> {
    try {
      const result = await pool.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM public.monitoring_drawdown
         ${machine === undefined ? '' : 'WHERE machine = $1'}`,
        machine === undefined ? [] : [machine],
      );
      const count = Number(result.rows[0]?.total);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw databaseUnavailable();
      }
      return count;
    } catch {
      throw databaseUnavailable();
    }
  }

  async function ping(): Promise<void> {
    try {
      await pool.query('SELECT 1');
    } catch {
      throw databaseUnavailable();
    }
  }

  async function close(): Promise<void> {
    try {
      await pool.end();
    } catch {
      throw databaseUnavailable();
    }
  }

  return { findReport, saveReport, findReportsByJobIds, listReports, countReports, ping, close };
}

function getDefaultDatabase(): Database {
  if (defaultDatabase === undefined) {
    const config = loadConfig('worker');
    if (config.service !== 'worker') {
      throw databaseUnavailable();
    }
    defaultDatabase = createDatabase(config.database);
  }
  return defaultDatabase;
}

export async function findReport(message: IncomingMessage): Promise<FinalRecord | null> {
  return getDefaultDatabase().findReport(message);
}

export async function saveReport(
  message: IncomingMessage,
  parsed: ParsedChecklist,
): Promise<FinalRecord> {
  return getDefaultDatabase().saveReport(message, parsed);
}

export async function closeDatabase(): Promise<void> {
  const database = defaultDatabase;
  defaultDatabase = undefined;
  if (database !== undefined) {
    await database.close();
  }
}

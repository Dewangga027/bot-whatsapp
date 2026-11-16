import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { loadConfig } from './config.js';
import type { ServiceConfig } from './config.js';

type MigrationConfig = Extract<ServiceConfig, { service: 'migrate' }>;

const MIGRATIONS_DIRECTORY = new URL('../db/migrations/', import.meta.url);
const APPLICATION_ROLES = ['monitor_worker', 'monitor_reader'];

function migrationUnavailable(): Error & { code: string } {
  return Object.assign(new Error('Migrasi PostgreSQL gagal'), { code: 'DATABASE_UNAVAILABLE' });
}

async function configureRoles(client: PoolClient, config: MigrationConfig): Promise<void> {
  const existing = await client.query<{ rolname: string }>(
    'SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])',
    [APPLICATION_ROLES],
  );
  for (const role of APPLICATION_ROLES) {
    if (!existing.rows.some(function isRole(row) { return row.rolname === role; })) {
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
    }
  }

  const unsafeRoles = await client.query<{ unsafe: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS role ON role.oid = membership.member
       WHERE role.rolname = ANY($1::text[])
     ) OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
       JOIN pg_catalog.pg_roles AS role ON role.oid = dependency.refobjid
       WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
         AND dependency.deptype = 'o' AND role.rolname = ANY($1::text[])
     ) AS unsafe`,
    [APPLICATION_ROLES],
  );
  if (unsafeRoles.rows[0]?.unsafe !== false) {
    throw migrationUnavailable();
  }

  // Bind secrets outside utility SQL; transaction-local settings disappear on COMMIT/ROLLBACK.
  await client.query('SET LOCAL log_parameter_max_length = 0');
  await client.query('SET LOCAL log_parameter_max_length_on_error = 0');
  await client.query('SET LOCAL log_error_verbosity = \'terse\'');
  await client.query('SET LOCAL password_encryption = \'scram-sha-256\'');
  await client.query(
    `SELECT set_config('monitoring.worker_password', $1, true),
            set_config('monitoring.reader_password', $2, true)`,
    [config.workerPassword, config.readerPassword],
  );
  await client.query(`DO $roles$
    BEGIN
      EXECUTE format(
        'ALTER ROLE monitor_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
        current_setting('monitoring.worker_password')
      );
      EXECUTE format(
        'ALTER ROLE monitor_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
        current_setting('monitoring.reader_password')
      );
      EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC, monitor_worker, monitor_reader', current_database());
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO monitor_worker, monitor_reader', current_database());
    END;
    $roles$`);
  await client.query(`
    REVOKE ALL ON SCHEMA public FROM PUBLIC, monitor_worker, monitor_reader;
    GRANT USAGE ON SCHEMA public TO monitor_worker, monitor_reader;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, monitor_worker, monitor_reader;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, monitor_worker, monitor_reader;
    DO $grants$
    BEGIN
      IF to_regclass('public.monitoring_drawdown') IS NOT NULL THEN
        GRANT SELECT, INSERT ON public.monitoring_drawdown TO monitor_worker;
        GRANT SELECT ON public.monitoring_drawdown TO monitor_reader;
      END IF;
    END;
    $grants$;
  `);
}

export async function runMigrations(config?: MigrationConfig): Promise<void> {
  const settings = config ?? loadConfig('migrate');
  if (settings.service !== 'migrate' || APPLICATION_ROLES.includes(settings.database.user)) {
    throw migrationUnavailable();
  }
  const pool = new Pool({ ...settings.database, max: 1, connectionTimeoutMillis: 5_000 });
  pool.on('error', function onPoolError() {
    console.error('PostgreSQL tidak tersedia');
  });
  try {
    const entries = await readdir(MIGRATIONS_DIRECTORY, { withFileTypes: true });
    const migrations = entries.filter(function isSqlFile(entry) {
      return entry.isFile() && entry.name.endsWith('.sql');
    }).map(function migrationName(entry) {
      return entry.name;
    }).sort();
    if (migrations.length === 0 || migrations.some(function invalidFilename(name) {
      return !/^[0-9]{3}-[a-z0-9-]+\.sql$/.test(name);
    })) {
      throw migrationUnavailable();
    }
    const versions = new Set(migrations.map(function migrationVersion(name) {
      return name.slice(0, 3);
    }));
    if (versions.size !== migrations.length) {
      throw migrationUnavailable();
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(850011)');
      await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      await configureRoles(client, settings);
      await client.query('COMMIT');

      for (const migration of migrations) {
        const sql = await readFile(new URL(migration, MIGRATIONS_DIRECTORY), 'utf8');
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(850011)');
        const applied = await client.query<{ version: string }>(
          'SELECT version FROM public.schema_migrations WHERE version = $1',
          [migration],
        );
        if (applied.rows.length === 0) {
          await client.query(sql);
          await client.query('INSERT INTO public.schema_migrations (version) VALUES ($1)', [migration]);
        }
        await client.query('COMMIT');
      }
    } catch {
      await client.query('ROLLBACK');
      throw migrationUnavailable();
    } finally {
      client.release(true);
    }
  } catch {
    throw migrationUnavailable();
  } finally {
    try {
      await pool.end();
    } catch {
      throw migrationUnavailable();
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log('Pemakaian: node dist/migrate.js [--help]\nMenjalankan migrasi berversi dan menyiapkan role PostgreSQL.\nMemerlukan kredensial administrator serta secret password worker dan reader dari konfigurasi migrate.');
  } else if (args.length > 0) {
    console.error('Argumen tidak dikenal. Gunakan --help.');
    process.exitCode = 1;
  } else {
    try {
      await runMigrations();
      console.log('Migrasi PostgreSQL diterapkan.');
    } catch {
      console.error('Migrasi PostgreSQL gagal');
      process.exitCode = 1;
    }
  }
}

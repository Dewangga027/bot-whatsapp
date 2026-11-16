import { readFileSync } from 'node:fs';

export type ServiceName = 'gateway' | 'worker' | 'api' | 'migrate' | 'ops';

type RedisConfig = {
  host: string;
  port: number;
  password: string;
};

type DatabaseConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

export type ServiceConfig =
  | {
      service: 'gateway';
      redis: RedisConfig;
      sessionKey: string;
      pairingMode: boolean;
      allowedGroupIds: string[];
    }
  | {
      service: 'worker';
      redis: RedisConfig;
      database: DatabaseConfig;
    }
  | {
      service: 'api';
      redis: RedisConfig;
      database: DatabaseConfig;
      apiReadToken: string;
      opsUser: string;
      opsPassword: string;
    }
  | {
      service: 'migrate';
      database: DatabaseConfig;
      workerPassword: string;
      readerPassword: string;
    }
  | {
      service: 'ops';
      redis: RedisConfig;
    };

function readValue(environment: NodeJS.ProcessEnv, key: string, defaultValue: string): string {
  const value = environment[key] ?? defaultValue;
  if (value.trim().length === 0) {
    throw new Error(`${key}: nilai tidak boleh kosong`);
  }
  return value;
}

function readPort(environment: NodeJS.ProcessEnv, key: string, defaultValue: string): number {
  const value = environment[key] ?? defaultValue;
  if (value.length === 0 || /[^0-9]/.test(value)) {
    throw new Error(`${key}: port harus berupa digit integer dalam rentang 1..65535`);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${key}: port harus berupa digit integer dalam rentang 1..65535`);
  }
  return port;
}

function readSecret(environment: NodeJS.ProcessEnv, key: string): string {
  const path = environment[key];
  if (path === undefined || path.trim().length === 0) {
    throw new Error(`${key}: path file wajib diisi`);
  }
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`${key}: file tidak dapat dibaca`);
  }
  const secret = contents.replace(/[\r\n]+$/, '');
  if (secret.trim().length === 0) {
    throw new Error(`${key}: file tidak boleh kosong atau hanya whitespace`);
  }
  return secret;
}

function readRedisConfig(environment: NodeJS.ProcessEnv): RedisConfig {
  return {
    host: readValue(environment, 'REDIS_HOST', 'redis'),
    port: readPort(environment, 'REDIS_PORT', '6379'),
    password: readSecret(environment, 'REDIS_PASSWORD_FILE'),
  };
}

function readDatabaseConfig(environment: NodeJS.ProcessEnv, defaultUser: string): DatabaseConfig {
  return {
    host: readValue(environment, 'PGHOST', 'db'),
    port: readPort(environment, 'PGPORT', '5432'),
    database: readValue(environment, 'PGDATABASE', 'monitoring'),
    user: readValue(environment, 'PGUSER', defaultUser),
    password: readSecret(environment, 'PGPASSWORD_FILE'),
  };
}

function readPairingMode(environment: NodeJS.ProcessEnv): boolean {
  const value = environment.PAIRING_MODE ?? 'false';
  switch (value) {
    case 'true':
      return true;
    case 'false':
      return false;
    default:
      throw new Error('PAIRING_MODE: nilai harus true atau false');
  }
}

function isGroupId(value: unknown): value is string {
  return typeof value === 'string' && value.endsWith('@g.us');
}

function readAllowedGroupIds(environment: NodeJS.ProcessEnv, pairingMode: boolean): string[] {
  let value: unknown;
  try {
    value = JSON.parse(environment.ALLOWED_GROUP_IDS ?? '[]');
  } catch {
    throw new Error('ALLOWED_GROUP_IDS: JSON tidak valid');
  }
  if (!Array.isArray(value)) {
    throw new Error('ALLOWED_GROUP_IDS: nilai harus berupa array string ID grup');
  }
  if (!value.every(isGroupId)) {
    throw new Error('ALLOWED_GROUP_IDS: setiap item harus berupa string ID grup berakhiran @g.us');
  }
  if (!pairingMode && value.length === 0) {
    throw new Error('ALLOWED_GROUP_IDS: mode normal memerlukan minimal satu ID grup');
  }
  return value;
}

export function loadConfig(
  service: ServiceName,
  environment: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  switch (service) {
    case 'gateway': {
      const pairingMode = readPairingMode(environment);
      return {
        service,
        redis: readRedisConfig(environment),
        sessionKey: readValue(environment, 'SESSION_KEY', 'monitoring'),
        pairingMode,
        allowedGroupIds: readAllowedGroupIds(environment, pairingMode),
      };
    }
    case 'worker':
      return {
        service,
        redis: readRedisConfig(environment),
        database: readDatabaseConfig(environment, 'monitor_worker'),
      };
    case 'api':
      return {
        service,
        redis: readRedisConfig(environment),
        database: readDatabaseConfig(environment, 'monitor_reader'),
        apiReadToken: readSecret(environment, 'API_READ_TOKEN_FILE'),
        opsUser: readValue(environment, 'OPS_USER', 'operator'),
        opsPassword: readSecret(environment, 'OPS_PASSWORD_FILE'),
      };
    case 'migrate':
      return {
        service,
        database: readDatabaseConfig(environment, 'postgres'),
        workerPassword: readSecret(environment, 'POSTGRES_WORKER_PASSWORD_FILE'),
        readerPassword: readSecret(environment, 'POSTGRES_READER_PASSWORD_FILE'),
      };
    case 'ops':
      return {
        service,
        redis: readRedisConfig(environment),
      };
    default:
      throw new Error('service: layanan tidak didukung');
  }
}

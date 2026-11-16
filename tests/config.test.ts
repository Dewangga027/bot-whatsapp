import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { loadConfig } from '../src/config.js';
import type { ServiceName } from '../src/config.js';

function createSecrets(t: TestContext): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(tmpdir(), 'monitor-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, contents] of [
    ['REDIS_PASSWORD_FILE', 'uji-redis\r\n'],
    ['PGPASSWORD_FILE', 'uji-db\n'],
    ['API_READ_TOKEN_FILE', 'uji-token\n'],
    ['OPS_PASSWORD_FILE', 'uji-ops\n'],
    ['POSTGRES_WORKER_PASSWORD_FILE', 'uji-worker\n'],
    ['POSTGRES_READER_PASSWORD_FILE', 'uji-reader\n'],
  ]) {
    const path = join(directory, key);
    writeFileSync(path, contents, 'utf8');
    environment[key] = path;
  }
  return environment;
}

function assertConfigError(
  service: ServiceName,
  environment: NodeJS.ProcessEnv,
  key: string,
  forbidden: string[] = [],
): void {
  assert.throws(() => loadConfig(service, environment), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(key));
    assert.equal(error.cause, undefined);
    for (const value of forbidden) {
      assert.equal(String(error.stack).includes(value), false);
    }
    return true;
  });
}

test('pairing gateway needs only Redis, strips CRLF, and defaults to an empty allowlist', (t) => {
  const secrets = createSecrets(t);
  const environment = Object.freeze({
    REDIS_PASSWORD_FILE: secrets.REDIS_PASSWORD_FILE,
    PAIRING_MODE: 'true',
  });
  const config = loadConfig('gateway', environment);
  assert.deepEqual(config, {
    service: 'gateway',
    redis: { host: 'redis', port: 6379, password: 'uji-redis' },
    sessionKey: 'monitoring',
    pairingMode: true,
    allowedGroupIds: [],
  });
  assert.equal('database' in config, false);
});

test('normal gateway defaults pairing to false and preserves explicit group IDs', (t) => {
  const secrets = createSecrets(t);
  const config = loadConfig('gateway', {
    REDIS_PASSWORD_FILE: secrets.REDIS_PASSWORD_FILE,
    ALLOWED_GROUP_IDS: '["test-group@g.us", "other-group@g.us"]',
    SESSION_KEY: 'test-session',
  });
  assert.equal(config.service, 'gateway');
  if (config.service !== 'gateway') assert.fail('Expected gateway config');
  assert.equal(config.pairingMode, false);
  assert.equal(config.sessionKey, 'test-session');
  assert.deepEqual(config.allowedGroupIds, ['test-group@g.us', 'other-group@g.us']);
});

for (const pairingMode of [undefined, 'false']) {
  test(`normal gateway rejects an absent or empty allowlist with pairing ${pairingMode}`, (t) => {
    const secrets = createSecrets(t);
    for (const allowlist of [undefined, '[]']) {
      assertConfigError('gateway', {
        REDIS_PASSWORD_FILE: secrets.REDIS_PASSWORD_FILE,
        PAIRING_MODE: pairingMode,
        ALLOWED_GROUP_IDS: allowlist,
      }, 'ALLOWED_GROUP_IDS');
    }
  });
}

for (const allowlist of [
  'invalid-json-sentinel',
  '{"credential-sentinel":true}',
  'null',
  '"credential-sentinel"',
  '[12]',
  '[null]',
  '["test-group@g.us", false]',
  '["credential-sentinel@s.whatsapp.net"]',
  '[""]',
]) {
  test(`gateway rejects malformed allowlist ${allowlist} even in pairing mode`, (t) => {
    const secrets = createSecrets(t);
    assertConfigError('gateway', {
      REDIS_PASSWORD_FILE: secrets.REDIS_PASSWORD_FILE,
      PAIRING_MODE: 'true',
      ALLOWED_GROUP_IDS: allowlist,
    }, 'ALLOWED_GROUP_IDS', [allowlist, 'credential-sentinel']);
  });
}

for (const pairingMode of ['', 'TRUE', '1', ' false ', 'credential-sentinel']) {
  test(`gateway rejects nonliteral pairing mode ${JSON.stringify(pairingMode)}`, (t) => {
    const secrets = createSecrets(t);
    assertConfigError('gateway', {
      REDIS_PASSWORD_FILE: secrets.REDIS_PASSWORD_FILE,
      PAIRING_MODE: pairingMode,
      ALLOWED_GROUP_IDS: '["test-group@g.us"]',
    }, 'PAIRING_MODE', ['credential-sentinel']);
  });
}

test('worker needs only Redis and its database credentials', (t) => {
  const secrets = createSecrets(t);
  assert.deepEqual(loadConfig('worker', {
    REDIS_PASSWORD_FILE: secrets.REDIS_PASSWORD_FILE,
    PGPASSWORD_FILE: secrets.PGPASSWORD_FILE,
  }), {
    service: 'worker',
    redis: { host: 'redis', port: 6379, password: 'uji-redis' },
    database: { host: 'db', port: 5432, database: 'monitoring', user: 'monitor_worker', password: 'uji-db' },
  });
});

test('ops needs only Redis credentials', (t) => {
  const secrets = createSecrets(t);
  assert.deepEqual(loadConfig('ops', {
    REDIS_PASSWORD_FILE: secrets.REDIS_PASSWORD_FILE,
  }), {
    service: 'ops',
    redis: { host: 'redis', port: 6379, password: 'uji-redis' },
  });
});

test('api needs Redis, reader database, and two API secrets', (t) => {
  const secrets = createSecrets(t);
  assert.deepEqual(loadConfig('api', {
    REDIS_PASSWORD_FILE: secrets.REDIS_PASSWORD_FILE,
    PGPASSWORD_FILE: secrets.PGPASSWORD_FILE,
    API_READ_TOKEN_FILE: secrets.API_READ_TOKEN_FILE,
    OPS_PASSWORD_FILE: secrets.OPS_PASSWORD_FILE,
  }), {
    service: 'api',
    redis: { host: 'redis', port: 6379, password: 'uji-redis' },
    database: { host: 'db', port: 5432, database: 'monitoring', user: 'monitor_reader', password: 'uji-db' },
    apiReadToken: 'uji-token',
    opsUser: 'operator',
    opsPassword: 'uji-ops',
  });
});

test('migrate needs only admin database and two role passwords', (t) => {
  const secrets = createSecrets(t);
  assert.deepEqual(loadConfig('migrate', {
    PGPASSWORD_FILE: secrets.PGPASSWORD_FILE,
    POSTGRES_WORKER_PASSWORD_FILE: secrets.POSTGRES_WORKER_PASSWORD_FILE,
    POSTGRES_READER_PASSWORD_FILE: secrets.POSTGRES_READER_PASSWORD_FILE,
  }), {
    service: 'migrate',
    database: { host: 'db', port: 5432, database: 'monitoring', user: 'postgres', password: 'uji-db' },
    workerPassword: 'uji-worker',
    readerPassword: 'uji-reader',
  });
});

const serviceKeys: { service: ServiceName; keys: string[] }[] = [
  { service: 'gateway', keys: ['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD_FILE', 'SESSION_KEY', 'PAIRING_MODE', 'ALLOWED_GROUP_IDS'] },
  { service: 'worker', keys: ['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD_FILE', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD_FILE'] },
  { service: 'api', keys: ['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD_FILE', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD_FILE', 'API_READ_TOKEN_FILE', 'OPS_USER', 'OPS_PASSWORD_FILE'] },
  { service: 'migrate', keys: ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD_FILE', 'POSTGRES_WORKER_PASSWORD_FILE', 'POSTGRES_READER_PASSWORD_FILE'] },
  { service: 'ops', keys: ['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD_FILE'] },
];

for (const { service, keys } of serviceKeys) {
  test(`${service} never accesses unrelated environment fields or secrets`, (t) => {
    const environment = createSecrets(t);
    environment.PAIRING_MODE = 'true';
    const guardedEnvironment = new Proxy(environment, {
      get(target, key: string) {
        assert.ok(keys.includes(key), `Unrelated environment access: ${key}`);
        return target[key];
      },
    });
    assert.equal(loadConfig(service, guardedEnvironment).service, service);
  });
}

test('explicit connection and API username overrides are retained', (t) => {
  const config = loadConfig('api', {
    ...createSecrets(t),
    REDIS_HOST: 'test-redis',
    REDIS_PORT: '6380',
    PGHOST: 'test-db',
    PGPORT: '5433',
    PGDATABASE: 'test-database',
    PGUSER: 'test-reader',
    OPS_USER: 'test-operator',
  });
  assert.equal(config.service, 'api');
  if (config.service !== 'api') assert.fail('Expected api config');
  assert.deepEqual(config.redis, { host: 'test-redis', port: 6380, password: 'uji-redis' });
  assert.deepEqual(config.database, { host: 'test-db', port: 5433, database: 'test-database', user: 'test-reader', password: 'uji-db' });
  assert.equal(config.opsUser, 'test-operator');
});

for (const key of ['REDIS_PORT', 'PGPORT']) {
  for (const port of ['0', '65536', '1.5', 'abc', '', '-1', '+1', '1e3', ' 80', '80 ', '80\n']) {
    test(`rejects invalid ${key} ${JSON.stringify(port)}`, (t) => {
      assertConfigError('worker', { ...createSecrets(t), [key]: port }, key, ['abc']);
    });
  }
  for (const port of ['1', '65535']) {
    test(`accepts ${key} boundary ${port}`, (t) => {
      const config = loadConfig('worker', { ...createSecrets(t), [key]: port });
      if (config.service !== 'worker') assert.fail('Expected worker config');
      assert.equal(key === 'REDIS_PORT' ? config.redis.port : config.database.port, Number(port));
    });
  }
}

for (const { service, key } of [
  { service: 'gateway', key: 'SESSION_KEY' },
  { service: 'worker', key: 'REDIS_HOST' },
  { service: 'worker', key: 'PGHOST' },
  { service: 'worker', key: 'PGDATABASE' },
  { service: 'worker', key: 'PGUSER' },
  { service: 'api', key: 'OPS_USER' },
] satisfies { service: ServiceName; key: string }[]) {
  for (const value of ['', ' \t ']) {
    test(`rejects blank ${key} ${JSON.stringify(value)}`, (t) => {
      assertConfigError(service, {
        ...createSecrets(t),
        PAIRING_MODE: 'true',
        [key]: value,
      }, key);
    });
  }
}

for (const { service, key } of [
  { service: 'ops', key: 'REDIS_PASSWORD_FILE' },
  { service: 'worker', key: 'PGPASSWORD_FILE' },
  { service: 'api', key: 'API_READ_TOKEN_FILE' },
  { service: 'api', key: 'OPS_PASSWORD_FILE' },
  { service: 'migrate', key: 'POSTGRES_WORKER_PASSWORD_FILE' },
  { service: 'migrate', key: 'POSTGRES_READER_PASSWORD_FILE' },
] satisfies { service: ServiceName; key: string }[]) {
  test(`${key} rejects missing, blank, unreadable, and empty secrets without leaking values`, (t) => {
    const environment = createSecrets(t);
    const originalPath = environment[key];
    assert.ok(originalPath);
    for (const path of [undefined, '', ' \t ', `${originalPath}-credential-sentinel`]) {
      assertConfigError(service, { ...environment, [key]: path }, key, ['credential-sentinel', originalPath, 'ENOENT']);
    }
    for (const contents of ['', '\r\n', ' \t\r\n']) {
      writeFileSync(originalPath, contents, 'utf8');
      assertConfigError(service, environment, key, [originalPath]);
    }
  });
}

test('secret reading preserves content spaces and internal newlines, stripping only final CR/LF', (t) => {
  const environment = createSecrets(t);
  const path = environment.REDIS_PASSWORD_FILE;
  assert.ok(path);
  for (const [contents, expected] of [
    [' spasi-valid \n', ' spasi-valid '],
    ['uji\ninternal\r\n\n', 'uji\ninternal'],
    ['uji-non-ascii-é\r', 'uji-non-ascii-é'],
    ['uji-no-newline', 'uji-no-newline'],
  ]) {
    writeFileSync(path, contents, 'utf8');
    const config = loadConfig('ops', { REDIS_PASSWORD_FILE: path });
    if (config.service !== 'ops') assert.fail('Expected ops config');
    assert.equal(config.redis.password, expected);
  }
});

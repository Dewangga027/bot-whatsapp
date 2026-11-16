#!/bin/sh
set -eu

if [ "${NODE_ENV:-}" != test ] || [ "${TEST_ISOLATED:-}" != true ] ||
   [ "${RUN_INTEGRATION_TESTS:-}" != true ] || [ "${PGHOST:-}" != db-test ] ||
   [ "${REDIS_HOST:-}" != redis-test ] || [ "${PGDATABASE:-}" != monitoring_test ] ||
   [ "${PGUSER:-}" != postgres ]; then
  printf '%s\n' 'Tests menolak target di luar store Compose uji.' >&2
  exit 1
fi

node dist/migrate.js
exec npm test

#!/bin/sh
set -eu

password_file=${REDIS_PASSWORD_FILE:-/run/secrets/redis-password}
if [ ! -r "$password_file" ]; then
  printf '%s\n' 'Redis secret tidak dapat dibaca.' >&2
  exit 1
fi
password=$(cat "$password_file")
if [ -z "$password" ]; then
  printf '%s\n' 'Redis secret kosong.' >&2
  exit 1
fi

# Entrypoint resmi mengatur kepemilikan /data lalu menurunkan user ke redis.
exec /usr/local/bin/docker-entrypoint.sh redis-server /opt/monitoring/redis.conf --requirepass "$password"

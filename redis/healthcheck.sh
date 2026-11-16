#!/bin/sh
set -eu

password_file=${REDIS_PASSWORD_FILE:-/run/secrets/redis-password}
[ -r "$password_file" ] || exit 1
REDISCLI_AUTH=$(cat "$password_file")
[ -n "$REDISCLI_AUTH" ] || exit 1
export REDISCLI_AUTH
reply=$(redis-cli --no-auth-warning ping 2>/dev/null) || exit 1
[ "$reply" = PONG ]

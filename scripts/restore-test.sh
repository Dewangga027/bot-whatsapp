#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'Pemakaian: bash scripts/restore-test.sh restore --backup /media/backup/SNAPSHOT --project monitoring-restore-test-NAMA --output /home/operator/restore-BARU --confirm-test-only' \
    'Hanya backup buatan sendiri yang dipercaya. Memerlukan image lokal hasil build/pull pengguna.' \
    'Membuat volume baru, jaringan internal baru, dan kredensial fixture uji; tidak menyalakan worker/gateway/API.' \
    'Tidak menghapus resource pada kegagalan. Tidak pernah menimpa volume existing atau menjalankan down -v.'
}
if [[ $# == 0 || ${1:-} == --help || ${1:-} == -h ]]; then usage; exit 0; fi
[[ $1 == restore ]] || { usage >&2; exit 1; }
shift
backup=''
project=''
output=''
confirmed=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --backup) [[ $# -ge 2 ]] || exit 1; backup=$2; shift 2 ;;
    --project) [[ $# -ge 2 ]] || exit 1; project=$2; shift 2 ;;
    --output) [[ $# -ge 2 ]] || exit 1; output=$2; shift 2 ;;
    --confirm-test-only) confirmed=true; shift ;;
    *) usage >&2; exit 1 ;;
  esac
done
[[ $confirmed == true && $project =~ ^monitoring-restore-test-[a-z0-9][a-z0-9-]*$ && $backup == /* && $output == /* ]] || { usage >&2; exit 1; }
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
backup=$(cd -- "$backup" && pwd -P)
parent=$(cd -- "$(dirname -- "$output")" && pwd -P)
output="$parent/$(basename -- "$output")"
case "$output/" in "$root/"*|"$backup/"*) printf '%s\n' 'Output tidak boleh di repo atau direktori backup.' >&2; exit 1 ;; esac
[[ ! -e $output && ! -L $output ]] || { printf '%s\n' 'Output harus belum ada.' >&2; exit 1; }
[[ $root != *\'* && $output != *\'* && $root != *$'\n'* && $output != *$'\n'* ]] || exit 1
[[ -f $backup/COMPLETE && $(cat "$backup/COMPLETE") == monitoring-backup-v1 ]] || { printf '%s\n' 'Backup belum lengkap.' >&2; exit 1; }
[[ -f $backup/postgres.dump && -f $backup/redis-data.tar && -f $backup/SHA256SUMS ]] || exit 1
(cd -- "$backup" && sha256sum --check --status SHA256SUMS) || { printf '%s\n' 'Checksum backup tidak cocok.' >&2; exit 1; }
command -v docker >/dev/null
command -v tar >/dev/null
command -v stat >/dev/null
docker info >/dev/null 2>&1
redis_image='redis:8.2.11-bookworm@sha256:b0b01167ff47bc3868e56a967895a26be4230891a1f42a78ab61cdd227accc8d'
postgres_image='postgres:18.7-bookworm@sha256:ece55f7868da684e400f82f1030a050718adbdd65c23aa500c486f6e2950dc0f'
for image in "$redis_image" "$postgres_image" monitoring-app; do
  docker image inspect "$image" >/dev/null 2>&1 || { printf '%s\n' 'Image lokal belum tersedia; siapkan image secara manual sebelum restore.' >&2; exit 1; }
done
redis_volume="${project}_redis_test"
postgres_volume="${project}_postgres_test"
network="${project}_private"
for volume in "$redis_volume" "$postgres_volume"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    printf '%s\n' 'Volume existing ditolak, pilih nama proyek uji baru.' >&2
    exit 1
  fi
done
if docker network inspect "$network" >/dev/null 2>&1 || [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$project") ]]; then
  printf '%s\n' 'Resource proyek existing ditolak.' >&2
  exit 1
fi
umask 077
mkdir -- "$output"
[[ $(stat -c '%a' "$output") == 700 ]] || { printf '%s\n' 'Output memerlukan filesystem dengan izin POSIX 0700.' >&2; exit 1; }
tar -tf "$backup/redis-data.tar" > "$output/archive-paths"
while IFS= read -r entry; do
  case "/$entry/" in //*|*/../*) printf '%s\n' 'Path arsip tidak aman.' >&2; exit 1 ;; esac
done < "$output/archive-paths"
tar -tvf "$backup/redis-data.tar" > "$output/archive-types"
while IFS= read -r entry; do
  case $entry in -?*|d?*) ;; *) printf '%s\n' 'Arsip hanya boleh berisi file biasa dan direktori.' >&2; exit 1 ;; esac
done < "$output/archive-types"

compose_file="$output/restore.compose.yaml"
cat > "$compose_file" <<EOF
name: $project
services:
  redis-test:
    image: '$redis_image'
    restart: 'no'
    entrypoint: [sh, /opt/monitoring/start.sh]
    environment:
      REDIS_PASSWORD_FILE: /run/secrets/redis-password
    secrets: [redis-password]
    volumes:
      - redis_test:/data
      - '$root/redis:/opt/monitoring:ro'
    networks: [restore_private]
    mem_limit: 1g
    stop_grace_period: 60s
    healthcheck:
      test: [CMD, sh, /opt/monitoring/healthcheck.sh]
      interval: 2s
      timeout: 5s
      retries: 30
  db-test:
    image: '$postgres_image'
    restart: 'no'
    environment:
      POSTGRES_DB: monitoring_test
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-admin-password
    secrets: [postgres-admin-password]
    volumes: [postgres_test:/var/lib/postgresql]
    networks: [restore_private]
    stop_grace_period: 60s
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -U postgres -d monitoring_test']
      interval: 2s
      timeout: 5s
      retries: 30
  migrate:
    image: monitoring-app
    profiles: [ops]
    restart: 'no'
    init: true
    read_only: true
    tmpfs: ['/tmp:size=64m,mode=1777']
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    command: [node, dist/migrate.js]
    environment:
      NODE_ENV: test
      PGHOST: db-test
      PGPORT: '5432'
      PGDATABASE: monitoring_test
      PGUSER: postgres
      PGPASSWORD_FILE: /run/secrets/postgres-admin-password
      POSTGRES_WORKER_PASSWORD_FILE: /run/secrets/postgres-worker-password
      POSTGRES_READER_PASSWORD_FILE: /run/secrets/postgres-reader-password
    secrets: [postgres-admin-password, postgres-worker-password, postgres-reader-password]
    networks: [restore_private]
networks:
  restore_private:
    name: $network
    external: true
volumes:
  redis_test:
    name: $redis_volume
    external: true
  postgres_test:
    name: $postgres_volume
    external: true
secrets:
  redis-password:
    file: '$root/tests/fixtures/redis-password-test'
  postgres-admin-password:
    file: '$root/tests/fixtures/postgres-admin-password-test'
  postgres-worker-password:
    file: '$root/tests/fixtures/postgres-worker-password-test'
  postgres-reader-password:
    file: '$root/tests/fixtures/postgres-reader-password-test'
EOF
compose=(docker compose --env-file /dev/null -f "$compose_file" -p "$project")
restore_complete=false
stores_started=false
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ $restore_complete != true ]]; then
    if [[ $stores_started == true ]]; then
      "${compose[@]}" stop --timeout 60 redis-test db-test >/dev/null 2>&1 || true
    fi
    printf '%s\n' 'Restore gagal; hanya resource uji baru dihentikan, data parsial dipertahankan. Pilih proyek baru untuk percobaan berikutnya.' >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker network create --internal --label monitoring.restore-test=true "$network" >/dev/null
docker volume create --label monitoring.restore-test=true "$redis_volume" >/dev/null
docker volume create --label monitoring.restore-test=true "$postgres_volume" >/dev/null
docker run --rm -i --pull=never --network none --read-only \
  --mount "type=volume,source=$redis_volume,target=/data" --entrypoint tar "$redis_image" \
  -C /data --keep-old-files --no-same-owner --no-same-permissions -xpf - < "$backup/redis-data.tar" 2>/dev/null
stores_started=true
"${compose[@]}" up --pull never --no-build -d --wait --wait-timeout 90 db-test redis-test >/dev/null 2>&1
"${compose[@]}" exec -T db-test sh -eu -c '
  PGPASSWORD=$(cat "$POSTGRES_PASSWORD_FILE")
  export PGPASSWORD
  exec pg_restore --exit-on-error --no-owner --no-privileges -U postgres -d monitoring_test
' < "$backup/postgres.dump" >/dev/null 2>&1
"${compose[@]}" --profile ops run --rm --no-deps --pull never migrate >/dev/null 2>&1
"${compose[@]}" exec -T db-test sh -eu -c '
  PGPASSWORD=$(cat "$POSTGRES_PASSWORD_FILE")
  export PGPASSWORD
  exec psql -X -v ON_ERROR_STOP=1 -U postgres -d monitoring_test -Atc "SELECT count(*) FROM monitoring_drawdown"
' > "$output/report-count.txt" 2>/dev/null
"${compose[@]}" exec -T redis-test sh -eu -c '
  REDISCLI_AUTH=$(cat "$REDIS_PASSWORD_FILE")
  export REDISCLI_AUTH
  exec redis-cli --no-auth-warning DBSIZE
' > "$output/redis-key-count.txt" 2>/dev/null
restore_complete=true
printf '%s\n' 'Restore uji tersedia tanpa worker/gateway/API. Data hasil restore tetap sensitif walau credential uji.'
printf 'Periksa jumlah pada %s. Hentikan dengan: docker compose --env-file /dev/null -f %q -p %q stop\n' "$output" "$compose_file" "$project"

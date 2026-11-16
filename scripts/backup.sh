#!/usr/bin/env bash
set -euo pipefail

require_native_storage() {
  local mount_info filesystem source extra
  mount_info=$(findmnt --kernel --noheadings --raw --first-only --target "$1" --output FSTYPE,SOURCE) || {
    printf '%s\n' 'Sumber filesystem tidak dapat diperiksa.' >&2
    exit 1
  }
  [[ $mount_info != *$'\n'* ]] || exit 1
  read -r filesystem source extra <<< "$mount_info"
  [[ -n $source && -z $extra ]] || exit 1
  printf 'Filesystem penyimpanan: type=%s, source=%s\n' "$filesystem" "$source"
  case $filesystem in
    ext2|ext3|ext4|xfs|btrfs|f2fs|zfs) ;;
    *) printf '%s\n' 'DrvFS/Windows/shared mount ditolak meskipun mode0700 terlihat. Pilih output pada filesystem Linux native, misalnya $HOME.' >&2; exit 1 ;;
  esac
}

usage() {
  printf '%s\n' 'Pemakaian: bash scripts/backup.sh create --project monitoring --output /media/backup/monitoring-BARU' \
    'Output harus direktori baru di luar repo pada media terlindungi. Jalankan dari Linux/WSL dengan akses Docker.' \
    'Memerlukan findmnt; DrvFS/Windows/shared mount ditolak termasuk metadata POSIX. Gunakan media Linux native atau $HOME Linux.' \
    'Hentikan operasi admin manual; helper menghentikan gateway/worker/api/pgadmin, dump SQL, lalu stop Redis dan arsip seluruh /data.' \
    'Hanya service yang sebelumnya berjalan dinyalakan kembali. Backup bukan snapshot atomik lintas store.'
}
if [[ $# == 0 || ${1:-} == --help || ${1:-} == -h ]]; then usage; exit 0; fi
[[ $1 == create ]] || { usage >&2; exit 1; }
shift
project=''
output=''
while [[ $# -gt 0 ]]; do
  case $1 in
    --project) [[ $# -ge 2 ]] || exit 1; project=$2; shift 2 ;;
    --output) [[ $# -ge 2 ]] || exit 1; output=$2; shift 2 ;;
    *) usage >&2; exit 1 ;;
  esac
done
[[ $project =~ ^[a-z0-9][a-z0-9_-]*$ && $output == /* ]] || { usage >&2; exit 1; }
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
parent=$(cd -- "$(dirname -- "$output")" && pwd -P)
output="$parent/$(basename -- "$output")"
case "$output/" in "$root/"*) printf '%s\n' 'Backup di dalam repo ditolak.' >&2; exit 1 ;; esac
[[ ! -e $output && ! -L $output ]] || { printf '%s\n' 'Output harus belum ada.' >&2; exit 1; }
command -v findmnt >/dev/null
require_native_storage "$parent"
command -v docker >/dev/null
command -v sha256sum >/dev/null
command -v stat >/dev/null
docker info >/dev/null 2>&1
compose=(docker compose --project-directory "$root" -f "$root/compose.yaml" -p "$project" --profile '*')
running=$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Label "com.docker.compose.service"}} {{.Label "com.docker.compose.oneoff"}} {{.ID}}')
writers=()
writer_ids=()
redis_running=false
db_running=false
while IFS=' ' read -r service oneoff container_id; do
  if [[ $oneoff == True || $oneoff == true ]]; then
    printf '%s\n' 'Hentikan container one-off sebelum backup.' >&2
    exit 1
  fi
  case $service in
    gateway|worker|api|pgadmin) writers+=("$service"); writer_ids+=("$container_id") ;;
    redis) redis_running=true ;;
    db) db_running=true ;;
    nodered-smoke|'') ;;
    *) printf '%s\n' 'Hentikan service admin/uji/one-off sebelum backup.' >&2; exit 1 ;;
  esac
done <<< "$running"
[[ $redis_running == true && $db_running == true ]] || { printf '%s\n' 'Redis dan DB harus sudah berjalan.' >&2; exit 1; }
redis_id=$("${compose[@]}" ps -q redis)
[[ -n $redis_id && $redis_id != *$'\n'* ]] || exit 1
redis_image=$(docker inspect --format '{{.Config.Image}}' "$redis_id")
umask 077
mkdir -- "$output"
require_native_storage "$output"
[[ $(stat -c '%a' "$output") == 700 ]] || { printf '%s\n' 'Output memerlukan filesystem dengan izin POSIX 0700.' >&2; exit 1; }
restart_writers=false
restart_redis=false
backup_complete=false
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ $restart_redis == true ]]; then
    if ! "${compose[@]}" start redis >/dev/null 2>&1; then
      printf '%s\n' 'Redis belum berhasil dinyalakan kembali; writer tetap berhenti.' >&2
      restart_writers=false
      status=1
    fi
  fi
  if [[ $restart_writers == true && ${#writers[@]} -gt 0 ]]; then
    if ! "${compose[@]}" start "${writers[@]}" >/dev/null 2>&1; then
      printf '%s\n' 'Sebagian writer belum berhasil dinyalakan kembali; periksa status Compose.' >&2
      status=1
    fi
  fi
  if [[ $backup_complete != true ]]; then
    printf '%s\n' 'Backup tidak lengkap. File parsial dipertahankan, jangan digunakan untuk restore.' >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ ${#writers[@]} -gt 0 ]]; then
  restart_writers=true
  "${compose[@]}" stop --timeout 60 "${writers[@]}" >/dev/null 2>&1
  for container_id in "${writer_ids[@]}"; do
    [[ $(docker inspect --format '{{.State.Running}}' "$container_id") == false ]] || exit 1
    [[ $(docker inspect --format '{{.State.ExitCode}}' "$container_id") != 137 ]] || {
      printf '%s\n' 'Writer menerima SIGKILL; snapshot dihentikan.' >&2
      exit 1
    }
  done
fi
"${compose[@]}" exec -T db sh -eu -c '
  PGPASSWORD=$(cat "$POSTGRES_PASSWORD_FILE")
  export PGPASSWORD
  exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc
' > "$output/postgres.dump.partial" 2>/dev/null
restart_redis=true
"${compose[@]}" stop --timeout 60 redis >/dev/null 2>&1
[[ $(docker inspect --format '{{.State.Running}}' "$redis_id") == false ]] || exit 1
[[ $(docker inspect --format '{{.State.ExitCode}}' "$redis_id") != 137 ]] || {
  printf '%s\n' 'Redis menerima SIGKILL; snapshot dihentikan.' >&2
  exit 1
}
docker run --rm --pull=never --network none --read-only --volumes-from "$redis_id:ro" \
  --entrypoint tar "$redis_image" -C /data -cpf - . > "$output/redis-data.tar.partial" 2>/dev/null
mv -- "$output/postgres.dump.partial" "$output/postgres.dump"
mv -- "$output/redis-data.tar.partial" "$output/redis-data.tar"
(cd -- "$output" && sha256sum postgres.dump redis-data.tar > SHA256SUMS)
printf 'format=monitoring-backup-v1\nproject=%s\ncreated_utc=%s\nredis_image=%s\n' \
  "$project" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$redis_image" > "$output/metadata"
printf '%s\n' 'monitoring-backup-v1' > "$output/COMPLETE"
backup_complete=true
printf '%s\n' 'Backup tersimpan. Uji restore pada target baru; simpan media beserta kontrol aksesnya.'

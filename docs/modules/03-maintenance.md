# 03. Maintenance

Lakukan prosedur mutatif hanya setelah memilih project dan menjadwalkan dampaknya. Command berikut bukan bukti bahwa backup, restart, atau pemulihan pernah berhasil.

## Pemeriksaan rutin

Dari WSL Ubuntu, direktori `/mnt/e/bot-whatsapp-1`, dengan `COMPOSE_PROJECT_NAME` sesuai target dan Docker Engine native yang disetujui. Setelah perubahan shell/context atau host, periksa kembali endpoint dan OS daemon seperti [modul setup](01-setup.md#wsl-dan-dependency); jangan menjalankan operasi melalui Docker Desktop. Perubahan dependency/image perlu pemeriksaan ulang [lisensi dan ketentuan layanan](05-licenses.md), bukan hanya perubahan digest.

```bash
docker compose --profile whatsapp ps
docker compose logs --tail 100 gateway worker api
docker stats --no-stream
docker system df
df -h
```

Baca log lokal seperlunya. Log aplikasi harus generik dan tidak memuat body pesan, QR normal mode, token, password, atau SQL sensitif. Detail staging, Bull Board, dump, dan data volume tetap sensitif meskipun log aplikasi tersanitasi. Jangan menyalin screenshot/job/raw ke issue publik.

Periksa Redis tanpa menaruh password pada argumen CLI:

```bash
docker compose exec -T redis sh -eu -c '
  REDISCLI_AUTH=$(cat "$REDIS_PASSWORD_FILE")
  export REDISCLI_AUTH
  redis-cli --no-auth-warning INFO memory
  redis-cli --no-auth-warning INFO persistence
  redis-cli --no-auth-warning CONFIG GET appendonly appendfsync maxmemory maxmemory-policy save
'
```

Konfigurasi yang diharapkan dari source: AOF aktif, `appendfsync everysec`, `maxmemory 256mb`, `maxmemory-policy noeviction`, serta RDB default image tetap ada. Batas container Redis1GB dan shm gateway512MB adalah titik awal, bukan kapasitas yang telah diukur. Pantau `used_memory`, error persistence/AOF, kapasitas filesystem Engine native dan disk virtual WSL, serta pertumbuhan PostgreSQL/job.

Riwayat completed/failed dipertahankan. Tidak ada TTL, automatic cleanup, atau kebijakan retensi yang mengizinkan purge. Saat noeviction penuh, write ditolak; data lama tidak dibuang. Tanggapi dengan menahan ingestion yang terdampak, menilai kapasitas dan backup, lalu keputusan kapasitas/retensi eksplisit. Jangan memakai `FLUSHALL`, `docker system prune --volumes`, `down -v`, atau mengganti eviction policy sebagai pemulihan rutin.

## Failed job dan rekonsiliasi

1. Ambil ID dari Bull Board terautentikasi atau `/v1/staging?state=failed`. Native state harus `failed`; status bisnis saja tidak cukup.
2. Periksa dependency tanpa mengubah raw. SQL mati, Redis gagal, disk penuh, atau credential bermasalah membutuhkan pemulihan penyebab lebih dahulu.
3. Jalankan satu retry yang dipilih:

   ```bash
   docker compose --profile ops run --rm ops node dist/ops.js retry JOB_ID
   ```

4. Periksa native state, result, dan final SQL sesudah pemrosesan. Exit0 CLI berarti job failed dikembalikan ke antrean, bukan berarti laporan sudah accepted. Jika worker belum hidup, job dapat tetap waiting.

CLI menolak ID tidak ditemukan dan state selain failed. `completed` dengan result `invalid` dikoreksi dengan pesan baru, bukan retry. `active` juga ditolak. Worker mencari final sebelum parse; failed yang finalnya sudah committed tetap boleh di-retry untuk menyelaraskan Redis, tanpa overwrite row final atau raw.

`attempts=1` mencegah retry exception otomatis. Stalled recovery bawaan BullMQ tetap berlaku untuk kehilangan worker/lock, dengan lock30s, interval30s, maxStalledCount1. Jangan menambah loop retry atau mengira stalled recovery menjamin semua kegagalan akan pulih sendiri.

## Restart dan perubahan konfigurasi

Restart normal setelah menilai dampak:

```bash
docker compose --profile whatsapp restart redis gateway worker
```

Periksa status, antrean, raw, dan duplikasi final seperti prosedur penerimaan. `restart` tidak menerapkan perubahan environment/image Compose. Setelah mengubah `.env`, image, atau konfigurasi service, gunakan `up -d` pada service terkait setelah meninjau konfigurasi. Jika memakai Node-RED external overlay, sertakan `-f compose.yaml -f compose.nodered.yaml` pada operasi yang membuat ulang API.

Grace Compose60s memberi kesempatan gateway menunggu enqueue aktif lalu menutup browser/queue, dan worker menunggu pekerjaan aktif sebelum menutup DB/Redis. Kill paksa dapat meninggalkan job active untuk stalled recovery. Jangan menganggap exit137 normal atau menjanjikan flush profil/AOF tanpa pemeriksaan.

`SESSION_KEY` merupakan bagian identity final bersama `message_id`; mengubahnya dapat membuat pesan yang sama dianggap identitas baru. Jangan menggantinya hanya karena container direstart. Edit/revoke pesan WhatsApp tidak mengubah histori final; koreksi dikirim sebagai pesan baru.

## Sesi WhatsApp dan credential

Untuk pairing ulang, stop gateway lalu gunakan command foreground pada setup. Jangan menghapus volume auth untuk mengatasi setiap error. Jika sesi perlu dicabut karena keamanan, stop gateway dan cabut perangkat tertaut melalui WhatsApp pada ponsel pemilik; tindakan itu membatalkan sesi. Pairing berikutnya memerlukan operator/QR lagi. Simpan volume auth dengan akses terbatas; jangan membagikannya sebagai artefak debugging.

Helper backup di bawah **hanya** mencadangkan Redis dan PostgreSQL, bukan volume auth, pgAdmin, flow Node-RED, konfigurasi, atau secret. Jika perlu mencadangkan profil/sesi/flow, lakukan sebagai prosedur terpisah saat penulisnya berhenti, dengan kontrol akses setara credential. Jangan mengklaim snapshot store sudah cukup untuk pemulihan seluruh host.

`setup-secrets.mjs create` tidak merotasi credential existing. Mengubah file password admin PostgreSQL tidak otomatis mengubah password cluster yang sudah diinisialisasi. Rotasi harus mengoordinasikan perubahan credential di server, file mount, role/migrasi, dan restart/recreate client. Jangan menjalankan initdb baru, mengganti volume, atau menulis password ke command/history sebagai jalan pintas. API token yang diganti perlu dibaca ulang oleh API dan Node-RED; file `ops-password` terpisah dari token baca.

Untuk akses remote, pakai HTTPS/VPN dan autentikasi yang melindungi dashboard HTTP **serta Socket.IO**. `adminAuth` Node-RED hanya untuk admin/editor, bukan perlindungan otomatis dashboard. Jangan membuka port3000/5050/1881 atau DB/Redis ke internet. Gateway `SYS_ADMIN` tetap capability luas; penggunaan sandbox resmi bukan klaim container tanpa risiko.

## Backup store dengan penulis berhenti

Prerequisite: Bash Linux/WSL, Docker CLI/Compose, GNU tar/coreutils, parent output yang sudah ada pada media terlindungi, dan ruang yang cukup. Gunakan filesystem Linux asli dengan permission POSIX efektif, misalnya direktori `$HOME` atau media Linux yang terpasang. Jangan memakai Windows-backed `/mnt/e`, sekalipun mode POSIX terlihat benar, karena mode itu tidak membuktikan perlindungan Windows DACL. Aturan yang sama berlaku untuk output restore. Output harus direktori baru di luar repo.

Sebelum backup, selesaikan/hentikan operasi admin manual dan container one-off, serta hentikan service test pada project itu. Jangan ada enqueue, retry, migrasi, query mutatif, atau perubahan Compose paralel. Helper menolak one-off/admin/test aktif yang tidak didukung.

```bash
bash scripts/backup.sh --help
bash scripts/backup.sh create \
  --project monitoring \
  --output /media/backup/monitoring-20261116
```

Ganti `monitoring` dengan project nyata, misalnya `monitoring-lab`, dan gunakan nama output baru setiap kali. Parent `/media/backup` harus benar-benar tersedia serta terlindungi; contoh bukan perintah membuat atau memasang disk.

Urutan helper:

1. Memastikan Redis/DB project sudah berjalan dan mencatat service yang semula aktif.
2. Menghentikan gateway, worker, API, pgAdmin yang aktif dengan grace60s. Exit137/SIGKILL membuat backup ditolak.
3. Membuat `pg_dump -Fc` ke file parsial, sesudah penulis berhenti.
4. Menghentikan Redis normal, lalu mengarsipkan **seluruh `/data`**, termasuk manifest dan semua bagian AOF multipart serta RDB. Jangan menggantinya dengan salinan satu `appendonly.aof`.
5. Memfinalkan `postgres.dump`, `redis-data.tar`, `SHA256SUMS`, `metadata`, dan marker `COMPLETE`.
6. Menyalakan kembali hanya service yang semula aktif, Redis lebih dahulu. Bila start Redis gagal, writer tidak dinyalakan oleh trap.

Output mode0700 membatasi akses direktori. File parsial dipertahankan pada kegagalan; jangan dipakai untuk restore atau dihapus otomatis sebelum investigasi. Periksa exit code dan status service setelah helper selesai, termasuk jika snapshot lengkap tetapi restart service gagal.

Snapshot lintas Redis/PostgreSQL tidak diklaim atomik. Penghentian penulis mengurangi perubahan saat snapshot, tetapi AOF everysec tetap berisiko kehilangan perubahan terakhir sekitar satu detik saat crash mendadak. Pesan yang belum pernah mencapai Redis/SQL tidak dapat dipulihkan dari snapshot tersebut.

## Restore selalu ke target uji baru

Jangan menguji restore dengan menimpa volume operasional. Helper membutuhkan image lokal hasil build/pull pengguna, backup sendiri yang dipercaya, marker/checksum valid, project baru dengan prefix `monitoring-restore-test-`, dan direktori output baru di luar repo/backup. Dump SQL tidak aman diperlakukan sebagai input publik karena `pg_restore` dapat menjalankan SQL dari dump.

```bash
bash scripts/restore-test.sh --help
bash scripts/restore-test.sh restore \
  --backup /media/backup/monitoring-20261116 \
  --project monitoring-restore-test-20261116 \
  --output "$HOME/restore-monitoring-20261116" \
  --confirm-test-only
```

Helper menolak resource existing; tidak overwrite atau `down -v`. Volume baru bernama `monitoring-restore-test-20261116_redis_test` dan `_postgres_test`, network internal `_private`. Fixture credential uji menggantikan credential runtime target restore, **bukan** menyamarkan data hasil restore: raw dan final tetap sensitif.

Redis dipulihkan dari seluruh arsip. SQL di-restore ke `monitoring_test` memakai `--no-owner --no-privileges --exit-on-error`, lalu migrasi mengembalikan role/grant memakai fixture. Helper tidak menyalakan worker, gateway, API, atau port host. `report-count.txt` dan `redis-key-count.txt` hanya pemeriksaan awal, bukan bukti replay/deduplikasi.

Manifest hasil ada pada `$HOME/restore-monitoring-20261116/restore.compose.yaml`. Untuk inspeksi awal:

```bash
docker compose --env-file /dev/null \
  -f "$HOME/restore-monitoring-20261116/restore.compose.yaml" \
  -p monitoring-restore-test-20261116 ps
```

Bandingkan jumlah final dengan catatan sebelum backup dan periksa identitas/field beberapa fixture. Query administrator read-only pada target restore:

```bash
docker compose --env-file /dev/null \
  -f "$HOME/restore-monitoring-20261116/restore.compose.yaml" \
  -p monitoring-restore-test-20261116 exec -T db-test sh -eu -c '
    PGPASSWORD=$(cat "$POSTGRES_PASSWORD_FILE")
    export PGPASSWORD
    psql -X -v ON_ERROR_STOP=1 -U postgres -d monitoring_test -c \
      "SELECT count(*) AS reports FROM monitoring_drawdown"
    psql -X -v ON_ERROR_STOP=1 -U postgres -d monitoring_test -c \
      "SELECT session_key, message_id, count(*) FROM monitoring_drawdown GROUP BY session_key, message_id HAVING count(*) > 1"
  '
```

Harapan query kedua kosong. Itu membuktikan tidak ada duplikasi pada saat baca, bukan bahwa semua raw waiting sudah diproses. Periksa raw job terpilih melalui `createQueue`/`queue.getJob` dari image aplikasi, menggunakan Redis target restore dan fixture secret. Cocokkan `data.message` dengan fixture sebelum backup; jangan memindahkan hasil mentah ke log publik. Explicit queue perlu menunggu event client ready dengan deadline, lalu `queue.close()` dalam finally, bukan mengandalkan `queue.waitUntilReady()`.

### Melanjutkan antrean restore secara eksplisit

Lakukan tahap ini hanya setelah inspeksi awal, pada hasil restore **lab** yang memang disiapkan dengan fixture waiting/accepted. Jangan memakai credential operasional atau menghubungkan gateway. Manifest restore tidak mempunyai service worker. Contoh worker sementara ini memakai network restore dan fixture file dari repo; command harus dijalankan dari `/mnt/e/bot-whatsapp-1`:

```bash
docker run -d --name monitoring-restore-test-20261116-worker \
  --pull=never --init --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:size=64m,mode=1777 \
  --network monitoring-restore-test-20261116_private \
  --mount "type=bind,source=$PWD/tests/fixtures/redis-password-test,target=/run/secrets/redis-password,readonly" \
  --mount "type=bind,source=$PWD/tests/fixtures/postgres-worker-password-test,target=/run/secrets/postgres-worker-password,readonly" \
  -e REDIS_HOST=redis-test -e REDIS_PORT=6379 \
  -e REDIS_PASSWORD_FILE=/run/secrets/redis-password \
  -e PGHOST=db-test -e PGPORT=5432 -e PGDATABASE=monitoring_test \
  -e PGUSER=monitor_worker \
  -e PGPASSWORD_FILE=/run/secrets/postgres-worker-password \
  monitoring-app node dist/worker.js
```

Nama container/network harus sama dengan project restore yang dibuat, dan nama worker harus belum ada. Ini command operator yang belum dijalankan. Jangan menjalankan `docker compose up worker` dari base stack sambil mengira ia otomatis menargetkan store restore.

Amati fixture waiting menjadi completed dengan satu final baru. Untuk fixture dengan final yang sudah ada tetapi ack Redis belum selesai, ulang pemrosesan harus mempertahankan row yang sama. Bandingkan jumlah/identitas sesudah worker memproses, bukan hanya count awal. Accepted completed tidak otomatis dijalankan ulang; skenario delete/re-enqueue khusus fixture diuji suite queue, bukan dengan purge restore. Hentikan worker setelah pemeriksaan:

```bash
docker stop --time 60 monitoring-restore-test-20261116-worker
docker compose --env-file /dev/null \
  -f "$HOME/restore-monitoring-20261116/restore.compose.yaml" \
  -p monitoring-restore-test-20261116 stop
```

Container/volume dipertahankan untuk bukti; tidak ada penghapusan otomatis. Pada restore gagal, helper menghentikan store baru bila sempat dimulai dan mempertahankan parsial. Percobaan berikutnya memakai project/output baru. Hasil restore baru boleh dianggap memenuhi skenario setelah pengguna membuktikan raw, final, dan replay tanpa duplikasi pada target uji tersebut.

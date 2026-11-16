# 02. Pengujian

Pengguna menjalankan perintah dan menilai hasil. Tabel di bawah berisi prosedur serta hasil yang diharapkan, bukan tanda lulus. Jangan menguji dengan database, Redis, credential, sesi WhatsApp, grup, atau volume operasional.

## Suite otomatis dengan store nyata

Dari Bash WSL Ubuntu:

```bash
cd /mnt/e/bot-whatsapp-1
docker compose --profile test build tests
docker compose --profile test run --rm tests
```

Harapan: build selesai, entrypoint migrasi selesai, seluruh tes selesai dengan exit0. Exit nonzero adalah kegagalan yang perlu ditelusuri; jangan menggantinya dengan skip atau mengubah target menjadi store operasional. Simpan ringkasan jumlah tes dan error tersanitasi, tanpa credential atau raw message operasional.

Service `tests` memakai image target `tests`, dependency dev, source tests, dan hasil compile. Entrypoint `scripts/test-entrypoint.sh` memeriksa:

```text
NODE_ENV=test
TEST_ISOLATED=true
RUN_INTEGRATION_TESTS=true
PGHOST=db-test
REDIS_HOST=redis-test
PGDATABASE=monitoring_test
PGUSER=postgres
```

Setelah pemeriksaan, entrypoint menjalankan `node dist/migrate.js` lalu `npm test`. Compose memasang fixture file `*-test` dari `tests/fixtures` pada path secret yang diminta loader. Nilai ini khusus uji dan bukan credential operasional. Store hanya ada pada network `test_private`, tidak mempublikasikan port, dan memakai tmpfs terpisah; tidak memasang volume auth atau secret operasional.

`npm test` menjalankan `tests/*.test.ts`, termasuk integrasi. Tanpa environment terisolasi, fixture menolak, bukan diam-diam skip. Jangan menjalankan full suite dari host dengan `.env` operasional. Jangan mengubah hostname uji menjadi host DB produksi agar suite bisa tersambung.

`tests/support/integration.ts` membuat database `monitoring_test_<randomhex>`, menggunakan Redis DB1 untuk queue dan DB2 untuk API, serta mutex ownership di DB0. Cleanup hanya terhadap resource fixture yang dimilikinya. Jika runner dibunuh, lock/sisa job dapat membuat run berikutnya ditolak. Inspeksi bukti kegagalan dulu; tidak ada izin untuk `FLUSHALL`, purge, atau menghapus volume pengguna.

Sesudah bukti run uji disimpan, hentikan store tmpfs:

```bash
docker compose --profile test stop redis-test db-test
```

Menghentikan store tmpfs menghilangkan data uji sementara; startup berikutnya menyediakan store baru. Ini bukan pengujian persistensi AOF lintas restart dan tidak boleh dipakai untuk menyimpulkan backup sehat.

## Unit test dan build host opsional

Dengan Node24 serta `node_modules` yang dipasang untuk OS shell tersebut:

```bash
npm run test:unit
npm run build
```

`test:unit` berisi parser, config, dan adapter gateway tanpa WhatsApp/browser/store. Exit0 hanya membuktikan tes yang benar-benar berjalan; tidak membuktikan pipeline, sandbox Chromium, atau UI. Build menghasilkan `dist` dan dapat menemukan masalah TypeScript yang tidak dibuktikan oleh bantuan source.

Bantuan source dan helper yang dapat diperiksa tanpa layanan dijelaskan pada modul setup. Source `--help` tidak membuka koneksi atau membaca secret. Jangan menyamakan bantuan source yang berhasil dengan hasil compile atau startup layanan.

## Peta sumber tes

| File | Perilaku yang disiapkan dalam source |
| --- | --- |
| `tests/parser.test.ts` | I/G, desimal, koma, negatif, field, duplikasi label, dan invalid |
| `tests/config.test.ts` | Environment, file secret, validasi port/pairing/allowlist |
| `tests/gateway.test.ts` | Metadata verbatim, sender null, penyaringan event, tidak menafsirkan prefix ID |
| `tests/queue.test.ts` | Redis/PostgreSQL nyata, waiting, duplicate, invalid, retry, konkurensi, crash commit, shutdown |
| `tests/api.test.ts` | HTTP server benar-benar listen, auth/query/paging/projection, board, gangguan dependency |
| `tests/support/crash-worker.ts`, `pipeline.ts` | Child worker dan penahanan COMMIT khusus tes, bukan failpoint executable produksi |

Suite antrean menguji koneksi Redis yang gagal dan reconnect client, bukan seluruh kondisi server restart/AOF atau memory noeviction. Skenario manual di bawah tetap diperlukan. Crash test memakai parameter produksi lock30s/stalled30s/maxStalledCount1 dengan deadline90s; jangan memperpendeknya hanya agar tes terlihat cepat.

## Lab manual untuk penerimaan

Siapkan project `monitoring-lab` melalui [setup](01-setup.md), dengan secret/volume sendiri, port localhost yang bebas, nomor khusus, dan grup uji berizin. Profile `test-ui` membaca API lab tersebut. Jangan menjalankan suite integrasi terhadap database lab ini: suite tetap melalui profile `test`.

Catat setiap percobaan dengan project, commit/source yang dipakai, ID fixture, waktu, langkah, exit/HTTP status aktual, dan bukti yang tidak memuat secret. Untuk membandingkan SQL, gunakan endpoint final dan, bila perlu, query SELECT administrator pada DB lab; detail staging/Bull Board memuat raw dan result.

### Semua skenario penerimaan AGENT.md

| Skenario | Prosedur pengguna | Hasil yang diharapkan |
| --- | --- | --- |
| Parser contoh I dan G | Jalankan unit suite; enqueue fixture I pada setup dan G dengan ID baru. Setelah worker hidup, baca final API. | I tidak berubah menjadi1; I menghasilkan8/2.9/-0.5, G menghasilkan8.3/3/-0.2; metadata tetap. |
| Field hilang/ganda/kosong, suffix, pemisah campuran | Pada lab, kirim satu pesan baru per variasi: hilangkan Vacuum; ulangi Tekanan; kosongkan Keterangan; gunakan `8 mm`; gunakan `1,2.3`. | `invalid` dengan alasan field; tidak ada row final untuk identitas itu. |
| Keterangan titik dua/HTML | Kirim fixture dengan `Keterangan: Catatan: <b>uji</b>`; periksa raw, parsed, dan tabel smoke. | Isi setelah titik dua tetap utuh; markup tampil sebagai teks, bukan elemen HTML atau script. |
| Worker berhenti, gateway enqueue | Stop worker lab, jalankan gateway lab, kirim pesan dari anggota lain. Periksa detail staging sebelum menyalakan worker. | Job waiting dan raw tersimpan; final belum ada. Sesudah worker hidup, final muncul. |
| Event dengan ID sama dua kali | Jalankan ulang fixture manual setup dengan `session_key`/`message_id` sama; jangan menciptakan ID baru. | Satu job tersimpan, raw pertama tidak ditimpa, satu row final. |
| Accepted job dihapus lalu identitas sama masuk lagi | Jalankan kasus permanen `tests/queue.test.ts` yang menghapus **job fixture accepted miliknya sendiri**, lalu enqueue identitas sama dengan raw berubah. Jangan menghapus job operasional melalui board. | Job Redis boleh dibuat kembali; final-first lookup dan unique identity menjaga satu final yang tidak berubah. |
| Worker mati sebelum COMMIT | Jalankan suite test; helper child menahan tepat sebelum COMMIT, parent SIGKILL child lalu memulai worker. | Belum ada row committed saat ditahan; stalled recovery akhirnya menghasilkan satu final dalam deadline tes. |
| Worker mati sesudah COMMIT sebelum ack Redis | Jalankan suite test dengan penahanan sesudah COMMIT berhasil dan sebelum processor selesai. | Row sudah terlihat; recovery menemukan row tersebut dan tidak menggandakan final. |
| Dua worker satu identitas | Jalankan kasus konkurensi nyata pada suite: dua job fixture dengan identitas laporan sama, kedua INSERT ditahan lock SQL khusus tes lalu dilepas. | Unique constraint menjaga satu final; tidak overwrite raw/final. |
| Format invalid | Kirim satu fixture dengan header checklist benar tetapi field invalid; baca native state dan returnvalue. | Native `completed`, result `invalid`; bukan `accepted` dan tidak ada final. |
| SQL mati | Pada lab saja, stop `db`, lalu enqueue ID baru saat worker hidup. Periksa failed lewat board; staging API dapat503 karena butuh SQL. Hidupkan `db`, lalu retry failed eksplisit. | Error teknis dan job tetap ada; tidak retry otomatis. Setelah pulih dan retry operator, satu final. |
| Redis mati atau penuh | Stop Redis lab, lalu coba satu enqueue dengan `--no-deps` agar Compose tidak menyalakannya otomatis. Untuk penuh, gunakan lab khusus dengan budget rendah/prosedur noeviction di bawah. | Exit gagal/`NOT_STAGED`, tidak mengaku sudah distaging, tidak ada fallback RAM/SQL. |
| Redis mati sesudah final tersimpan | Setelah accepted fixture terlihat, stop Redis lab dan panggil final API serta staging/summary. | Final SQL tetap200; staging/summary503, bukan array kosong palsu. Health503. |
| Redis dan worker restart | Catat raw/job/final; restart Redis, gateway, worker lab dengan command di bawah. | Retensi job/raw dapat dibaca, final tidak ganda, sesi WhatsApp yang masih valid tidak meminta QR ulang. |
| Board tanpa login/mutasi | Uji HTML, aset, JSON tanpa login; lalu mutasi dengan login pada rute library yang ditunjukkan di bawah. | Tanpa login401; mutasi terautentikasi405. |
| Failed retry | Ambil ID native failed; pulihkan sebab lalu jalankan CLI retry. Uji juga ID completed/active dari lab; kasus final sudah committed tercakup suite. | Hanya failed diterima; completed/active ditolak, raw dan final immutable. |
| Node-RED terputus/summary gagal | Matikan smoke Node-RED; kirim fixture dan cek API. Hidupkan lagi. Sesudah data sukses, stop Redis lab untuk summary gagal; untuk data gagal stop API lab, lalu pulihkan. | Gateway/worker tidak bergantung Node-RED. Final tetap ditampilkan saat hanya summary gagal; data gagal menandai data lama dan mempertahankan timestamp, bukan nol/empty palsu. |
| Backup/restore | Buat snapshot lab dengan writer berhenti melalui helper; restore ke volume/database uji baru, inspeksi raw/final, lalu lanjutkan worker hanya pada target restore seperti modul maintenance. | Raw dan final kembali; waiting dapat diproses dan rekonsiliasi accepted tidak membuat final ganda. Count awal saja belum cukup. |

### Perintah gangguan lab

Jangan jalankan blok ini sampai terminal memilih project lab yang benar. Saat menguji Redis offline, gunakan enqueue manual dari setup dengan `--no-deps` yang sudah disertakan; jangan menjalankan `up` atau `run` tanpa flag tersebut karena dependency dapat dinyalakan lagi.

```bash
export COMPOSE_PROJECT_NAME=monitoring-lab
docker compose stop db
# Enqueue fixture baru, amati failed, kemudian pulihkan:
docker compose start db
# Jalankan retry untuk JOB_ID yang sudah diperiksa native failed.
```

Untuk Redis outage dan pemulihan, lakukan sebagai percobaan terpisah:

```bash
docker compose stop redis
# Coba enqueue; panggil API final, staging, summary, dan health.
docker compose start redis
```

Tunggu health pulih sebelum retry atau menyimpulkan pemulihan. Reconnect library bukan replay pesan WhatsApp yang gagal distaging.

Untuk retensi gunakan named volume lab, bukan tmpfs suite:

```bash
docker compose --profile whatsapp restart redis gateway worker
docker compose --profile whatsapp ps
docker compose logs --tail 100 gateway worker api
```

Periksa juga shutdown gateway pada startup dan SIGTERM normal: browser harus ditutup, enqueue aktif ditunggu, profil tidak dibuka dua proses, dan startup berikutnya menggunakan auth valid. Log umum tidak boleh mencetak QR, raw body, token, atau password.

### Noeviction tanpa mengisi RAM operasional

Gunakan lab khusus yang tidak memiliki gateway/worker aktif. Catat `CONFIG GET maxmemory` dan `INFO memory`, lalu turunkan batas **hanya runtime Redis lab** sedikit di bawah `used_memory` agar write berikutnya ditolak. Nilai batas harus dipilih dari hasil pengukuran, bukan angka kapasitas karangan. Command autentikasi berikut tidak mencetak password:

```bash
docker compose exec -T redis sh -eu -c '
  REDISCLI_AUTH=$(cat "$REDIS_PASSWORD_FILE")
  export REDISCLI_AUTH
  redis-cli --no-auth-warning CONFIG GET maxmemory
  redis-cli --no-auth-warning INFO memory
'
```

Operator menjalankan `CONFIG SET maxmemory NILAI_BYTE_UJI` melalui pola autentikasi yang sama setelah menentukan nilai, lalu mencoba fixture enqueue baru. Harapan write ditolak dan fixture tidak dikonfirmasi tersimpan. Kembalikan nilai awal sebelum melanjutkan; `CONFIG SET` tidak dimaksudkan mengubah kebijakan permanen `redis/redis.conf`. Jangan mengisi berjuta job, mengubah noeviction menjadi eviction, atau menghapus data agar tampak pulih.

### Auth dan mutasi HTTP

Contoh tanpa credential dari host lab:

```bash
curl -i http://127.0.0.1:3000/v1/checklists
curl -i http://127.0.0.1:3000/ops/queues
curl -i http://127.0.0.1:3000/ops/queues/api/queues
```

Harapan401. Bearer benar memakai contoh server-side pada setup. Uji query salah dengan token benar, misalnya `limit=0`, `view=final&state=waiting`, atau `view=staging&machine=I`: harapan400 `INVALID_QUERY`.

Untuk penolakan mutasi, `curl --user operator` meminta password interaktif, bukan hardcode. Ganti username jika `OPS_USER` berbeda. Jalankan pada lab:

```bash
curl -i --user operator -X PUT \
  http://127.0.0.1:3000/ops/queues/api/queues/monitoring-drawdown/pause
```

Harapan405 dengan `Allow: GET, HEAD, OPTIONS`. Ulangi tanpa `--user`: harapan401. Suite API juga menargetkan add/retry/pause global/scheduler/delete dan aset board. Jangan melakukan percobaan mutasi pada data operasional meskipun kontrak mengharapkan penolakan.

### Izin database dan migrasi

Pada database uji khusus, jalankan ulang migrasi dan bandingkan `schema_migrations`: tidak boleh menambah versi duplikat. Dengan role `monitor_worker`, SELECT/INSERT final harus diizinkan, UPDATE/DELETE/TRUNCATE/DDL ditolak; dengan `monitor_reader`, SELECT diizinkan dan INSERT ditolak. Kedua role tidak boleh membaca `schema_migrations` atau membuat objek/temp table. Gunakan koneksi role yang benar, bukan sesi admin yang akan membuat tes privilege memberi kesan lulus palsu. Catat penolakan dan pastikan tidak ada perubahan data ketika menguji larangan.

## Penerimaan UI dan Node-RED

Pengujian smoke tidak membuktikan pemasangan pada widget existing. Pada masing-masing target yang memang tersedia, periksa:

- Loading awal, hasil sukses, empty sukses, error sebelum pernah sukses, error sesudah sukses, dan pemulihan siklus berikutnya.
- Data sukses tetapi summary gagal: data baru dan `last_success_at` data tetap diperbarui, status menjelaskan summary gagal. Data gagal: hasil/timestamp terakhir dipertahankan.
- Timeout body/network setelah4s melepaskan lock; pemicu berulang tidak membuat siklus tumpang tindih. Jangan menambahkan endpoint delay ke aplikasi produksi untuk tes ini; lakukan gangguan pada jaringan/server lab.
- Final diberi label100 laporan terbaru; staging label state/halaman, bukan pencarian seluruh server. Native counts tidak dilabeli valid/invalid.
- Sepuluh kolom tetap, angka belum valid null bukan0, timestamp sumber string detik, sender null tidak ditebak menjadi nomor.
- Keterangan HTML-like tampil sebagai teks. Inspeksi payload output/browser pada lab: tidak ada Authorization, token, atau response HTTP mentah yang diteruskan ke widget/debug.
- Keyboard/fokus, pembaca layar untuk status, viewport360/768/1280px, zoom200%, wrapping, tema existing, dan reduced-motion. Ukur kontras normal minimal4.5:1, large text dan kontrol/fokus minimal3:1. Catat alat/hasil; jangan mengklaim seluruh dashboard atau Bull Board aksesibel dari source saja.
- Volume smoke kosong mendapat seed. Setelah perubahan flow uji yang sah, restart tidak menimpanya. Volume nonkosong tanpa settings/flow harus gagal. Gunakan volume lab baru untuk kasus tersebut, bukan menghapus atau mengubah volume pengguna.

Jika akses existing/host pairing belum tersedia, catat prerequisite itu secara spesifik. Bukti parser, API, atau smoke tidak menggantikan bukti grup WhatsApp dan tabel existing.

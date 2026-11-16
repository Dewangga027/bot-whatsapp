# 04. Peta kode dan kepemilikan resource

Peta ini menjelaskan tempat mengubah aturan dan hubungan antarfile, bukan salinan source. Runtime Node24, TypeScript strict, ESM, import relatif berekstensi `.js`; build `tsc` menulis `dist` dari `src`.

## File yang dibaca saat mengubah perilaku

| File | Tanggung jawab | Baca/ubah bersama bila kontrak berubah |
| --- | --- | --- |
| `src/types.ts` | `IncomingMessage`, hasil parsing, job, sepuluh kolom dashboard | Semua konsumen payload dan tes terkait |
| `src/config.ts` | `loadConfig(service, environment?)`, validasi env dan secret-file per service | `.env.example`, mount/environment Compose, tes config |
| `src/parser.ts` | `isChecklistMessage`, `parseChecklist`; header, label wajib, grammar desimal | Tes parser, contoh input, adapter gateway untuk seleksi header |
| `src/queue.ts` | `QUEUE_NAME`, `createQueue`, `getJobId`, `enqueueMessage`, `closeQueue` | Worker, gateway, ops, lookup database, tes queue |
| `src/worker.ts` | `processChecklist`, `startWorker`, `WorkerHandle`; alur final-first dan shutdown | Database/queue contracts dan tes crash |
| `src/database.ts` | `createDatabase`, final immutable, SELECT/INSERT dan paging; default lazy helpers | SQL migration, worker, API, integration fixture |
| `src/migrate.ts` | `runMigrations`, role/grant, versi SQL, transaksi/advisory lock | `db/migrations/`, image yang membawa SQL, tes privilege |
| `src/gateway.ts` | `toIncomingMessage`, `startGateway`, WhatsApp lifecycle dan pairing | Allowlist/config, gateway Dockerfile, tes adapter, uji host nyata |
| `src/whatsapp-web-interface-controller.d.ts` | Deklarasi controller yang belum disertakan whatsapp-web.js1.34.8; `@types/node-fetch`2.6.13 melengkapi tipe node-fetch2.7.0 | Saat pin WhatsApp berubah, cocokkan ulang constructor/metode dengan `src/util/InterfaceController.js` upstream dan hapus deklarasi lokal bila upstream sudah menyediakannya; tetap periksa library dengan strict |
| `src/api.ts` | `createApi`, auth/query/projection, health, board, listen/shutdown | Header dashboard, adapter Node-RED, tes API |
| `src/ops.ts` | `retryFailedJob`; CLI `retry <job-id>` dan pemeriksaan native failed | Tes retry/reconciliation, prosedur operator |

Jangan membuat staging SQL, repository generik, DI container, alias kompatibilitas, atau loop retry tambahan untuk mengubah satu aturan. Validasi di boundary input, hasil invalid bisnis dibedakan dari exception teknis. Perubahan kontrak harus memperbarui seluruh caller dan tes terkait, bukan hanya satu entrypoint.

## Perjalanan satu pesan

1. Gateway menerima event `message`. Ia menolak pesan sendiri berdasarkan metadata, media, type selain `chat`, private, grup di luar allowlist, dan header tidak cocok. `message.id._serialized`, timestamp detik, from, author/null, body, dan type disalin tanpa menebak nomor atau menafsirkan prefix `true_` sebagai fromMe.
2. `IncomingMessage` menambahkan `session_key` dan `received_at` UTC. `queue.ts` memvalidasi bentuk metadata, safe nonnegative integer timestamp, dan tanggal UTC, tetapi tidak mem-parse field bisnis.
3. `getJobId` membuat `wa-` + SHA256 dari `JSON.stringify([session_key,message_id])`. ID asli tetap disimpan. Queue `monitoring-drawdown`, job name `checklist`, data `{message,parsed:null}`.
4. `processChecklist` mencari final lebih dahulu. Jika ada, langsung accepted. Jika belum, parser membaca raw; invalid dikembalikan sebagai result, bukan exception.
5. Hasil parsing valid disimpan melalui `job.updateData` sebelum INSERT SQL. Raw dan metadata tetap.
6. `saveReport` memakai transaksi, parameterized INSERT `ON CONFLICT(session_key,message_id) DO NOTHING`, membaca row identitas, lalu COMMIT. Baru setelah COMMIT processor mengembalikan accepted dan BullMQ menyelesaikan job.

Unique identity SQL melindungi dari duplikasi sesudah Redis job hilang atau worker mati pada celah commit/ack. Tidak ada jaminan pesan yang belum distaging akan diputar ulang, atau snapshot lintas store benar-benar atomik.

## Parser dan data final

`parser.ts` menerima judul `Monitoring drawdown` tanpa membedakan kapital pada pemeriksaan judul; label dikenali setelah normalisasi whitespace/case. Nilai mesin tetap string, jadi `I` tidak menjadi1. Separator field adalah titik dua pertama, sehingga titik dua berikutnya tetap bagian keterangan. Desimal menerima koma atau titik dan tanda, tanpa suffix satuan/pemisah campuran; hasil internal tetap string. Tidak ada satuan dan batas aman proses yang dibuat tanpa keputusan pengguna.

`ValidationError.code` tepat: `INVALID_HEADER`, `MALFORMED_LINE`, `UNKNOWN_FIELD`, `DUPLICATE_FIELD`, `MISSING_FIELD`, `EMPTY_FIELD`, `INVALID_DECIMAL`. Field invalid belum diterima sebagai row final.

`db/migrations/001-monitoring-drawdown.sql` membuat `monitoring_drawdown`, primary key `job_id`, unique `(session_key,message_id)`, numeric tanpa precision/scale arbitrer, timestamp sumber bigint, dan indeks `(received_at DESC,job_id DESC)` serta `(machine,received_at DESC,job_id DESC)`. Tidak ada SQL UPDATE status antrean.

`Database` menyediakan `findReport`, `saveReport`, `findReportsByJobIds`, `listReports`, `countReports`, `ping`, `close`. `FinalRecord` mengembalikan source timestamp dan numeric sebagai string; waktu received/accepted menjadi ISO UTC. Konversi numeric menjadi JSON number hanya pada projection dashboard API. `findReportsByJobIds` memberi satu lookup batch untuk halaman staging; final API tidak bergantung Redis.

Migrasi memakai `schema_migrations` dan `pg_advisory_xact_lock(850011)`, bukan hanya initdb. SQL dicari relatif terhadap modul, sehingga image runtime harus membawa direktori `db`. Bootstrap role dapat mencabut privilege PUBLIC pada database/schema; jangan menerapkannya pada database bersama aplikasi lain.

## Status dan output dashboard

Urutan projection staging di API:

1. Row SQL ada: `accepted` dan nilai final SQL menjadi acuan.
2. Result invalid: `invalid`.
3. Native failed: `failed`.
4. Parsed valid tersimpan: `queued`.
5. Selain itu: `received`.

Returnvalue accepted tanpa row SQL tidak cukup untuk mengaku final. Jika lookup SQL gagal, staging memberi503, termasuk halaman kosong; tidak menebak accepted. Native state tersedia terpisah pada detail staging. Counts dan paging dapat berubah ketika antrean bergerak; tidak ada snapshot global gabungan Redis/SQL.

Tabel pengguna tetap tepat sepuluh key:

| Key | Tipe JSON | Arti |
| --- | --- | --- |
| `message_id` | string | ID pesan sumber utuh |
| `timestamp` | string | Unix detik sumber, bukan milidetik/ISO |
| `chat_id` | string | ID grup sumber |
| `sender_id` | string atau null | Metadata pengirim, bukan nomor tebakan |
| `machine` | string atau null | Identifier mesin |
| `thickness` | number atau null | Hasil desimal di batas API |
| `pressure` | number atau null | Hasil desimal di batas API |
| `vacuum` | number atau null | Hasil desimal di batas API |
| `notes` | string atau null | Keterangan sebagai teks |
| `status` | string | received/queued/accepted/invalid/failed |

Nilai belum valid memakai null, bukan0. Raw, job ID, native state, serta alasan gagal berada pada endpoint detail/board, bukan kolom tambahan tabel.

## Siapa menutup koneksi

| Pemanggilan | Kepemilikan dan penutupan |
| --- | --- |
| `createQueue(settings)` | Caller memiliki queue; tutup `queue.close()` |
| `enqueueMessage(message)` tanpa queue | Modul membuat default lazy; caller one-shot wajib `closeQueue()` dalam finally |
| `enqueueMessage(message, queue)` | Tidak mengambil alih queue; caller tetap menutupnya |
| `createDatabase(settings)` | Caller memiliki satu Pool melalui object Database; `database.close()` |
| Standalone `findReport`/`saveReport` | Default worker DB lazy; `closeDatabase()` untuk resource default itu |
| `startWorker(config?)` | Handle memiliki worker, DB, dan koneksi Redis tersendiri; `await handle.close()` |
| `createApi(config?)` tanpa dependency | App memiliki queue/DB dan menutupnya pada `app.close()` |
| `createApi(config, {database,queue})` | Dependency tetap milik caller; tutup server dahulu, lalu client |
| `runMigrations(config?)` | Pool ditutup dalam finally |
| `retryFailedJob(id)` tanpa queue | Membuat queue sendiri dan menutupnya dalam finally |
| Gateway | Menunggu enqueue aktif, menutup browser, lalu queue; tidak logout |

Import entrypoint tidak menyalakan layanan. `--help` diproses sebelum config/koneksi. CLI produksi memakai `import.meta.main`; konfigurasi runtime tetap diperlukan saat benar-benar menjalankan layanan.

Queue gateway/API memakai `enableOfflineQueue=false`, `maxRetriesPerRequest=1`. `createQueue` tidak menunggu jaringan; `skipWaitingForReady` dan `skipVersionCheck` menghindari startup INFO yang merusak koneksi fail-fast. Karena itu `queue.waitUntilReady()` bukan bukti client Redis siap. Pemilik explicit queue yang perlu operasi pertama segera harus menunggu event client `ready`/`error` secara terbatas. Default lazy enqueue dan CLI retry sudah menangani initial wait maksimal5s; itu bukan retry add.

Worker memakai koneksi Redis tersendiri `maxRetriesPerRequest=null`, concurrency1, lockDuration30000, stalledInterval30000, maxStalledCount1. Queue attempts1 dan retensi completed/failed tetap; tidak ada QueueScheduler atau cleanup job otomatis.

## Entrypoint dan script npm

| Script | Command hasil compile / fungsi |
| --- | --- |
| `npm run build` | `tsc` |
| `npm test` | `tsx --test tests/*.test.ts`, hanya lingkungan integrasi terisolasi |
| `npm run test:unit` | parser/config/gateway tests tanpa store |
| `npm run start:api` | `node dist/api.js` |
| `npm run start:worker` | `node dist/worker.js` |
| `npm run start:gateway` | `node dist/gateway.js` |
| `npm run migrate` | `node dist/migrate.js` |
| `npm run ops -- retry JOB_ID` | `node dist/ops.js retry JOB_ID` |
| `npm run setup:secrets -- create --directory PATH` | `node scripts/setup-secrets.mjs create --directory PATH` |

Menggunakan script npm host tidak otomatis memuat `.env`, memetakan secret, atau menyambungkan network Docker. Untuk operasi biasa gunakan command Compose pada modul setup, bukan menyalin environment admin ke semua proses.

## Deployment dan file operasional

| Berkas | Pemilik aturan |
| --- | --- |
| `compose.yaml` | Profile, mounts minimum, network, port localhost, volume, grace, image service |
| `compose.nodered.yaml` | Opt-in API ke external `monitoring_shared` sebagai `monitoring-api` |
| `Dockerfile` | Target dependencies/build/tests/production-dependencies/runtime; app UID1000 |
| `gateway.Dockerfile` | Browser Puppeteer terpasang, cache, auth writable, runtime pptruser UID10042 |
| `.dockerignore`, `.gitignore`, `.gitattributes` | Pengecualian credential/data/dependency host dan LF script |
| `.env.example` | Key/path tanpa password mentah; bukan konfigurasi universal semua role |
| `redis/redis.conf`, `start.sh`, `healthcheck.sh` | AOF/everysec/noeviction, secret auth, privilege-drop entrypoint resmi, PONG |
| `scripts/setup-secrets.mjs` | Pembuatan eksklusif, izin POSIX/DACL, `.env` create-only |
| `scripts/test-entrypoint.sh` | Guard lingkungan uji, migrasi dasar, full suite |
| `scripts/backup.sh` | Stop writer, dump SQL, stop Redis, arsip penuh, restart service semula |
| `scripts/restore-test.sh` | Target uji baru, checksum/arsip, role fixture, tanpa worker/gateway/API |

Profile default berisi redis/db/worker/api; `whatsapp` gateway; `ops` migrate/ops/pgadmin; `test` redis-test/db-test/tests; `test-ui` nodered-smoke. Port host hanya API localhost3000, pgAdmin localhost5050, smoke localhost1881. Volume default: `monitoring_redis_data`, `monitoring_postgres_data`, `monitoring_whatsapp_auth`, `monitoring_pgadmin_data`, `monitoring_nodered_smoke_data`; override project mengganti prefix.

Pin image source, bukan hasil build yang sudah diuji:

| Pemakaian | Pin |
| --- | --- |
| App | `node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54` |
| Redis | `redis:8.2.11-bookworm@sha256:b0b01167ff47bc3868e56a967895a26be4230891a1f42a78ab61cdd227accc8d` |
| PostgreSQL | `postgres:18.7-bookworm@sha256:ece55f7868da684e400f82f1030a050718adbdd65c23aa500c486f6e2950dc0f` |
| Gateway | `ghcr.io/puppeteer/puppeteer:24.38.0@sha256:bcb4fd4543ceee3a6b8b9a81403ed4c09ae316dca8b857773cf67328c0c2ee3c` |
| Node-RED | `nodered/node-red:5.0.9-24@sha256:2ccd38b4066648bd5e17430c50a2f8102c566a82fd4f2fc5c342e61664d6896f` |
| pgAdmin | `dpage/pgadmin4:9.19.0@sha256:3591b3d02910dcd817dec6fcaa681c278ba6966945283dd0ea0042731c330c83` |

Versi dependency exact berada di `package.json` dan lockfile: whatsapp-web.js1.34.8, Puppeteer24.38.0, BullMQ5.81.5, ioredis5.11.1, Fastify5.12.8, pg8.23.1, Bull Board9.13.2, basic-auth6.3.1. Lockfile menentukan transitive dependency; jangan mengganti major BullMQ/backend antrean tanpa keputusan arsitektur.

## Node-RED: adapter berbeda dari UI uji

- `nodered/checklist-adapter.json`: subflow importable, polling5s, deadline4s/request, satu siklus aktif. Output1 array tabel; output2 `{state,message,last_success_at}`. Status state loading/ready/empty/error.
- `nodered/settings.fragment.cjs`: membaca API token ke `functionGlobalContext.monitoringApiReadToken` serta native HTTP helpers. Gabungkan globals saja ke settings existing.
- `nodered/smoke-flow.json`: halaman/tabel/status khusus TEST ONLY, ID baru, bukan widget existing.
- `nodered/smoke-settings.cjs`: editor/admin dimatikan, bukan proteksi login dashboard publik.
- `nodered/smoke.Dockerfile`: seed hanya volume kosong, tidak overwrite setiap restart.
- `nodered/package.json`/`package-lock.json`: Dashboard2 exact1.36.1 dan dependency terkunci.

Native fetch membuat Bearer server-side, redirect ditolak, header dibuang sebelum output. Tabel memakai cell Text dan status memakai escaped interpolation, bukan `v-html`. Pengubahan flow existing membutuhkan akses source existing; jangan menebak ID/page/theme atau memigrasikan Dashboard1 ke2 sebagai efek samping.

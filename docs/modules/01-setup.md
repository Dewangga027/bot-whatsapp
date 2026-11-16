# 01. Setup

Semua langkah di sini dilakukan operator. Belum ada hasil build, startup, pairing, atau koneksi yang dinyatakan berhasil.

Sebelum menjalankan langkah apa pun, baca [05 Lisensi dan penggunaan perusahaan](05-licenses.md). Jangan jalankan komponen yang belum disetujui kebijakan IT/legal, termasuk Redis8 AGPL, dependency LGPL, browser, dan akses WhatsApp. Panduan ini tidak menggunakan Docker Desktop.

## WSL dan dependency

Gunakan Docker Engine Community yang berjalan native di distro WSL2 Ubuntu, Docker CLI, serta plugin Compose/Buildx. Docker Desktop dan integrasi daemon Desktop ke WSL bukan prerequisite dan tidak digunakan. Compose perlu mendukung `up --wait`; Node.js24 diperlukan pada lingkungan yang menjalankan script setup. Akses registry mengikuti kebijakan perusahaan. Jalankan dari Bash:

```bash
cd /mnt/e/bot-whatsapp-1
node --version
docker version
docker compose version
```

Pastikan terminal WSL tidak sekadar menjadi client daemon Docker Desktop:

```bash
docker context show
docker context inspect --format '{{.Name}} {{.Endpoints.docker.Host}}'
docker info --format 'OS={{.OperatingSystem}}; Root={{.DockerRootDir}}'
dpkg-query -W docker-ce docker-ce-cli docker-compose-plugin docker-buildx-plugin containerd.io
```

Untuk jalur native yang dipakai proyek, context lokal biasanya `default`, endpoint `unix:///var/run/docker.sock`, OS daemon Ubuntu, dan data root `/var/lib/docker`. Socket Unix saja tidak membuktikan daemon native; cocokkan metadata daemon dan paket. Periksa juga pengaruh `DOCKER_HOST`/`DOCKER_CONTEXT` bila disetel. Jika muncul Docker Desktop, `desktop-linux`, atau endpoint Desktop, hentikan langkah berikutnya dan minta administrator memilih Engine native yang disetujui. Jangan mengganti context, memasang ulang Engine, memindahkan data root, atau menghapus volume secara otomatis.

Engine sudah tersedia pada device ini; tidak perlu memasang ulang atau menjalankan installer. Untuk host baru, administrator dapat mengikuti [instalasi Engine dari repository apt resmi](https://docs.docker.com/engine/install/ubuntu/#install-using-the-repository), bukan installer Desktop. Perubahan host, konfigurasi systemd, dan akses grup `docker` memerlukan persetujuan IT; grup tersebut memberi akses setara root. Lisensi Apache-2.0 pada Engine/CLI/Compose tidak sama dengan subscription Docker Desktop, sedangkan terms/rate limit registry tetap berlaku.

Node 24 di Windows dan Node 24 di WSL adalah instalasi berbeda. Jangan memakai `node_modules` hasil `npm ci` Windows untuk menjalankan tool Linux, atau sebaliknya. Checkout `/mnt/e` berbagi file dengan Windows; gunakan dependency host pada satu OS saja, atau checkout Linux terpisah untuk pekerjaan host. Build Docker memasang dependency Linux sendiri dan `.dockerignore` mengecualikan `node_modules` host. Docker tidak memerlukan `npm ci` host.

Untuk build/unit test host opsional, gunakan shell dan dependency OS yang sama:

```bash
npm ci --ignore-scripts
npm run build
npm run test:unit
```

`--ignore-scripts` mencegah unduhan browser kedua. Gateway memakai Chrome for Testing yang sudah ada dalam image Puppeteer, bukan Chromium host. Lisensi library Puppeteer tidak otomatis mencakup seluruh image/browser; lihat modul lisensi sebelum membangunnya. Full `npm test` bukan pengganti unit test host; jalankan melalui profile test pada [modul pengujian](02-testing.md).

## Pilih project baru untuk lab

Sebelum setup pertama, pastikan project yang dipilih belum berisi data operasional. Untuk lab manual, gunakan satu terminal yang mempertahankan variabel ini sepanjang prosedur:

```bash
export COMPOSE_PROJECT_NAME=monitoring-lab
```

`COMPOSE_PROJECT_NAME` mengesampingkan nama default `monitoring` pada Compose. Lab memiliki volume dan network sendiri, tetapi port host tetap 3000, 5050, dan 1881. Jangan menyalakannya bersamaan dengan stack lain yang memakai port tersebut. Pakai host uji tersendiri atau konfigurasi port lab yang ditinjau operator; mengganti nama project tidak menyelesaikan konflik port.

Contoh berikut mengikuti project yang dipilih. Bila tidak memakai override, nama engine diawali `monitoring_`. Jangan mengganti project setelah volume berisi data lalu menganggap data hilang.

## Secret create-only

Script menggunakan modul bawaan Node; tidak membutuhkan dependency npm. `--help` dan pemanggilan tanpa argumen hanya menampilkan petunjuk. Pembuatan memerlukan `create`:

```bash
node scripts/setup-secrets.mjs --help
```

Pada WSL, gunakan filesystem Linux asli milik operator, misalnya `$HOME`, bukan direktori Windows-backed `/mnt/e`:

```bash
node scripts/setup-secrets.mjs create --directory "$HOME/monitoring-lab-secrets"
export SECRETS_DIR="$HOME/monitoring-lab-secrets"
```

Alternatif `node scripts/setup-secrets.mjs create` memilih `SECRETS_DIR` dari environment proses atau `./secrets` jika tidak ada. Script tidak membaca `.env` untuk menentukan pilihan ini. Jangan menjalankan kedua alternatif dengan direktori berbeda tanpa tujuan yang jelas.

Script membuat tujuh file acak: `redis-password`, `postgres-admin-password`, `postgres-worker-password`, `postgres-reader-password`, `api-read-token`, `ops-password`, `pgadmin-password`. Nilai tidak dicetak. File existing tidak ditimpa; file kosong, symlink, atau direktori yang berisi nama lain ditolak. Kegagalan mempertahankan file yang sudah dibuat, bukan menghapusnya.

Pada POSIX, direktori harus milik operator dengan mode efektif `0700`; file secret memakai `0444`. Batas kerahasiaan host berada pada direktori `0700`. File dapat dibaca UID runtime berbeda ketika Docker memasangnya ke container tertentu. Jangan memindahkannya ke direktori publik, dan jangan mengubah semuanya menjadi `0600` tanpa memahami bahwa app UID1000 dan gateway UID10042 akan kehilangan akses. Compose lokal tidak otomatis menerapkan ulang UID/mode untuk bind-file secrets.

DrvFS `/mnt/e` dapat mengabaikan `chmod`; sekalipun metadata POSIX membuat mode terlihat benar, itu tidak membuktikan Windows DACL melindungi secret dari pengguna Windows lain. Jangan menyimpan secret WSL di sana atau mengatasi penolakan dengan permission world-writable. Gunakan `$HOME` Linux, sesuaikan `SECRETS_DIR`, dan periksa akses mount Docker sebagai langkah operator.

Node Windows memakai DACL operator+SYSTEM, tetapi alternatif itu memerlukan validasi akses Windows/Docker tersendiri. `.env` yang dibuat Node Windows dapat berisi `E:/...`; Docker Compose yang dijalankan dari WSL membutuhkan path Linux, bukan `E:/...` atau `E:\...`. Script tidak mengonversi atau menimpa `.env` existing secara otomatis. Untuk jalur WSL yang didokumentasikan di sini, gunakan Node24 WSL dan secret baru di `$HOME`, kemudian edit `SECRETS_DIR` existing ke path `/home/...` yang benar. Konversi path Windows menjadi `/mnt/e/...` saja tidak menyelesaikan risiko permission.

`.env` dibuat dari `.env.example` **hanya jika belum ada**. File baru mendapat `SECRETS_DIR` absolut pilihan script. Bila `.env` sudah ada, script tidak memperbaruinya: edit key `SECRETS_DIR` sendiri agar menunjuk direktori yang sama. Environment shell dapat mengesampingkan `.env`; periksa keduanya tanpa mencetak isi secret.

Key operator pada `.env`:

| Key | Pemakaian |
| --- | --- |
| `SECRETS_DIR` | Path direktori secret; untuk WSL gunakan path Linux absolut |
| `SESSION_KEY` | Identitas logis sesi laporan; pertahankan stabil setelah dipakai |
| `PAIRING_MODE` | Default `false`; gunakan override sementara saat pairing |
| `ALLOWED_GROUP_IDS` | Array JSON ID grup hasil pairing; awal `[]` |
| `OPS_USER` | Username Basic Auth Bull Board; default `operator` |
| `PGADMIN_DEFAULT_EMAIL` | Akun UI pgAdmin; ganti nilai contoh jika memakai pgAdmin |

Jangan menaruh password mentah di `.env`. Key `*_FILE` menunjuk file. `src/config.ts` membaca environment proses, bukan otomatis memuat `.env`; Compose memasang environment per service. Nama host `redis`/`db` dan `/run/secrets/...` berlaku di container, bukan alamat layanan host Windows.

## Suite terisolasi sebelum stack lab

Jalankan prosedur profile `test` pada [02-testing](02-testing.md) sebelum melanjutkan. Suite itu memakai fixture secret, tidak membutuhkan secret operasional, dan tidak melakukan pairing. Catat exit code dan kegagalan yang nyata; modul tidak mengasumsikan hasil lulus.

## Build, store, dan migrasi

```bash
docker compose config --quiet
docker compose build
docker compose up -d redis db
docker compose --profile ops run --rm migrate
```

Harapan: konfigurasi valid, build menghasilkan image `monitoring-app`, store menjadi healthy, migrasi exit 0. Hentikan urutan jika salah satu gagal. Jangan menyalakan worker sebelum migrasi berhasil.

Migrasi memakai admin `postgres`, tabel versi `schema_migrations`, dan transaksi/lock; rerun tidak menjalankan ulang migrasi yang tercatat, tetapi menyelaraskan password/grant role. Gunakan database khusus aplikasi `monitoring`, bukan database bersama. Bootstrap membatasi privilege PUBLIC serta role aplikasi. `monitor_worker` hanya SELECT/INSERT final, `monitor_reader` hanya SELECT. API tidak memakai password admin.

Base stack tidak membutuhkan network eksternal. Redis/DB tidak memiliki host port. API terikat `127.0.0.1:3000`; jaringan `redis_private`, `db_private`, `dashboard`, dan `test_private` bersifat internal. Gateway mendapat `redis_private` dan `whatsapp_egress`, tanpa jaringan/secret PostgreSQL.

pgAdmin opsional, bukan prasyarat pipeline. Isi `PGADMIN_DEFAULT_EMAIL` dengan alamat akun operator yang diterima pgAdmin, lalu:

```bash
docker compose --profile ops up -d pgadmin
```

Buka `http://127.0.0.1:5050` dengan email tersebut dan secret `pgadmin-password`. Ini password UI, bukan password database. Untuk koneksi baca, daftarkan host `db`, port5432, database `monitoring`, user `monitor_reader`, dan password role reader melalui prompt lokal terlindungi. Jangan memakai akun admin untuk membuktikan privilege reader atau menyimpan credential dalam laporan.

## Enqueue manual tanpa WhatsApp

Lakukan hanya pada project lab yang baru, bukan data operasional. Contoh ini memanggil API JavaScript hasil compile, bukan HTTP ingest. Worker dihentikan agar tahap waiting bisa diperiksa:

```bash
docker compose stop worker
docker compose up -d api
docker compose --profile ops run --rm -T --no-deps ops node --input-type=module <<'JS'
import { enqueueMessage, closeQueue } from './dist/queue.js';

const message = {
  session_key: 'manual-lab-001',
  message_id: 'manual-checklist-I-001',
  source_timestamp: 1794787200,
  chat_id: 'manual-lab@g.us',
  sender_id: null,
  received_at: '2026-11-16T00:00:00.000Z',
  raw_body: 'Monitoring drawdown\nMesin filling: I\nKetebalan: 8,0\nTekanan: 2,9\nVacuum: -0,5\nKeterangan: Kondisi bagus',
  message_type: 'chat',
};
try {
  console.log(await enqueueMessage(message));
} catch {
  console.error('Enqueue manual gagal; pesan belum dikonfirmasi tersimpan');
  process.exitCode = 1;
} finally {
  await closeQueue();
}
JS
```

Metadata di atas adalah fixture manual, bukan pesan WhatsApp asli. Simpan job ID yang dicetak. Pemanggilan tanpa parameter queue memakai queue lazy milik modul, menunggu koneksi pertama secara terbatas, kemudian `closeQueue()` menutupnya. Jangan mengganti dengan `queue.waitUntilReady()` sebagai bukti readiness jaringan: explicit queue memakai mode fail-fast.

Buka detail staging/Bull Board seperti bagian berikut. Harapan sebelum worker hidup: native `waiting`, raw utuh, belum ada final. Kemudian:

```bash
docker compose up -d worker
```

Harapan: satu final mesin `I`, angka JSON `8`, `2.9`, `-0.5`. Jalankan ulang fixture identik untuk menguji idempotensi; jangan mengubah `message_id` pada percobaan duplikat. Untuk contoh G gunakan ID baru, mesin `G`, ketebalan `8.3`, tekanan `3`, vacuum `-0.2`. Tidak ada penetapan satuan atau ambang aman mesin.

## API Bearer dan Bull Board

API baca dan login operator adalah dua credential berbeda. Semua `/v1/*` memerlukan `Authorization: Bearer <token>` dari `api-read-token`; `/ops/queues` memakai Basic Auth `OPS_USER` dan `ops-password`. Jangan memasukkan token ke URL, source flow, history shell, atau screenshot.

Contoh request dari container API membaca token server-side tanpa mencetaknya. Pilih path pada argumen terakhir:

```bash
docker compose exec -T api node --input-type=module - /v1/checklists?view=final <<'JS'
import { readFileSync } from 'node:fs';
const token = readFileSync(process.env.API_READ_TOKEN_FILE, 'utf8').trim();
try {
  const response = await fetch(new URL(process.argv[2], 'http://127.0.0.1:3000'), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  console.log('HTTP', response.status);
  console.log(await response.text());
  if (!response.ok) process.exitCode = 1;
} catch {
  console.error('Request API gagal');
  process.exitCode = 1;
}
JS
```

Output data dapat berisi identitas pesan; jalankan pada lab dan jangan unggah output mentah. Untuk path dengan `&`, kutip seluruh argumen, misalnya `'/v1/checklists?view=staging&state=waiting&limit=100&offset=0'`.

| Path | Bentuk hasil |
| --- | --- |
| `/v1/checklists?view=final` | Array sepuluh kolom dari SQL saja; default view |
| `/v1/checklists?view=staging&state=waiting` | Array sepuluh kolom satu native state |
| `/v1/staging?state=waiting` | Detail `{items,total,limit,offset}`, termasuk raw/result/alasan gagal |
| `/v1/staging/summary` | Native `queue_counts` dan `reports_accepted` |
| `/v1/monitoring?machine=I&limit=100&offset=0` | Envelope final SQL, machine exact-match |
| `/healthz` | Tanpa auth/data pesan, status dependency; 200 jika keduanya sehat, selainnya 503 |

Default limit100/offset0; limit1..500, offset integer nonnegatif. State: waiting/active/completed/failed/delayed/paused. Query asing, berulang, atau tidak cocok dengan view ditolak 400. Final menerima `machine`, bukan `state`; staging menerima `state`, bukan `machine`. Token hilang/salah menghasilkan 401; dependency gagal 503; empty yang berhasil menghasilkan 200 dan array kosong. Paging antrean bukan snapshot atomik lintas perubahan.

Buka `http://127.0.0.1:3000/ops/queues`, masukkan akun operator melalui prompt browser. Baca password dengan pengelola secret/editor lokal terlindungi, bukan dengan memasukkannya ke command atau laporan. HTML, aset, dan endpoint board dilindungi login. Mutasi sesudah login harus 405; tombol tersembunyi saja bukan bukti. Retry hanya lewat:

```bash
docker compose --profile ops run --rm ops node dist/ops.js --help
docker compose --profile ops run --rm ops node dist/ops.js retry JOB_ID
```

Ganti `JOB_ID` dengan ID nyata native failed, setelah penyebab diperbaiki. Completed invalid harus dikoreksi lewat pesan baru; jangan retry completed/active. Rincian di [maintenance](03-maintenance.md).

## Pairing operator dan izin grup

Gunakan nomor khusus dan grup uji yang disetujui. Build gateway terpisah karena profile `whatsapp` tidak aktif secara default:

```bash
docker compose --profile whatsapp build gateway
docker compose --profile whatsapp stop gateway
docker compose --profile whatsapp run --rm -e PAIRING_MODE=true gateway
```

Gunakan terminal foreground interaktif, tanpa `-T`, background, atau pengalihan output QR. Jangan membuka dua browser atas volume auth yang sama. Loader tetap membutuhkan secret Redis; pairing tidak membuat queue atau memasang listener ingestion. Setelah QR dipindai, gateway menampilkan ID/nama grup dari `getChats`, lalu menutup browser dan keluar.

Edit `ALLOWED_GROUP_IDS` pada `.env` menjadi array JSON berisi ID grup yang benar-benar ditampilkan, contohnya bentuk `['...']` **tidak valid JSON**; gunakan tanda kutip ganda untuk setiap ID. Pastikan `PAIRING_MODE=false`, `SESSION_KEY` stabil, lalu:

```bash
docker compose stop worker
docker compose --profile whatsapp up -d gateway api
```

Kirim contoh checklist dari anggota lain pada grup uji. Harapan: job waiting/raw tersimpan, belum final. Pesan sendiri, private, media, type selain chat, grup di luar allowlist, dan header tidak cocok tidak di-ingest. Setelah pemeriksaan:

```bash
docker compose up -d worker
```

Normal mode dengan allowlist kosong ditolak. Bila sesi memerlukan QR, mode normal memberi petunjuk pairing, bukan QR di log umum. LocalAuth memakai `clientId=monitoring`, `/data/wwebjs-auth`; shutdown tidak logout.

Gateway memakai non-root UID10042, `init`, shared memory512m, dan `SYS_ADMIN` untuk sandbox image Puppeteer. Capability ini luas. Jika host tidak mendukungnya, hentikan dan perbaiki prerequisite host bersama administrator. Jangan memakai `--no-sandbox`, privileged container, atau Docker socket sebagai jalan pintas.

## Node-RED smoke dan existing

### Smoke lokal

Smoke memakai API project lab, bukan `redis-test`/`db-test`. Jangan menganggap profile `test-ui` mencegahnya membaca API operasional jika project yang dipilih salah.

```bash
docker compose --profile test-ui build nodered-smoke
docker compose --profile test-ui up -d nodered-smoke
```

Buka `http://127.0.0.1:1881/dashboard/checklists`. Image memakai Node-RED5.0.9-24 dan Dashboard2 `1.36.1`. Volume `nodered_smoke_data` hanya di-seed ketika kosong; restart tidak menimpa flow/settings yang sudah ada. Volume nonkosong yang tidak memiliki settings/flow ditolak, bukan diperbaiki dengan overwrite.

Editor/admin API dimatikan, tetapi itu bukan autentikasi dashboard HTTP/Socket.IO. Batas smoke adalah localhost dan network internal `dashboard`. Tidak perlu `monitoring_shared` untuk smoke.

### Instalasi existing milik pengguna

Source/settings/Compose/URL existing tidak tersedia di repo. Operator harus memeriksanya sebelum perubahan. Jangan mengimpor `smoke-flow.json` atau mengganti settings existing dengan `smoke-settings.cjs`.

1. Pastikan runtime Node-RED mendukung native `fetch`/`AbortController`. Salin `nodered/settings.fragment.cjs` ke userDir existing, mount hanya file `api-read-token` yang terbaca UID Node-RED, lalu set `API_READ_TOKEN_FILE` ke path mount.
2. Gabungkan hanya globals pada akhir settings existing, sesudah `module.exports` didefinisikan:

   ```js
   const monitoring = require('./settings.fragment.cjs');
   module.exports.functionGlobalContext = {
     ...module.exports.functionGlobalContext,
     ...monitoring.functionGlobalContext,
   };
   ```

   Pertahankan `adminAuth`, `credentialSecret`, `httpRoot`, page, tema, dan pengaturan lain.
3. Pilih konektivitas. Native Node-RED pada host yang sama memakai `MONITORING_API_BASE_URL=http://127.0.0.1:3000`. Container pada engine yang sama memerlukan network bersama seperti langkah opt-in di bawah. Host lain memakai HTTPS/VPN pengguna, bukan HTTP ber-token melalui internet.
4. Restart Node-RED sesuai instalasi existing. Impor hanya `nodered/checklist-adapter.json`, buat instance subflow `Monitoring checklist adapter`. Output1 ke tabel existing dengan seluruh cell **Text**, output2 ke indikator yang merender `message`/`last_success_at` sebagai teks, tanpa `v-html`.
5. Default `MONITORING_VIEW=final`; staging memakai `MONITORING_VIEW=staging` dan `MONITORING_QUEUE_STATE=waiting` atau native state yang didukung. Tetap gunakan sepuluh header pada [peta kode](04-code-map.md).

Untuk container existing, setelah operator membaca Compose aslinya dan menyetujui koneksi:

```bash
docker network inspect monitoring_shared
```

Jika network belum ada dan memang akan digunakan, operator membuatnya:

```bash
docker network create monitoring_shared
```

Tambahkan external network bernama tepat `monitoring_shared` ke **service Node-RED existing saja** dalam Compose miliknya. Jangan sambungkan Redis/DB atau membagikan password store. Terapkan perubahan stack existing melalui prosedur milik pengguna. Lalu pada repo ini:

```bash
docker compose -f compose.yaml -f compose.nodered.yaml up -d api
```

Overlay memasang API ke external network dengan alias `monitoring-api`; set URL Node-RED menjadi `http://monitoring-api:3000`. Overlay tidak membuat network dan tidak mengubah stack existing otomatis. Gunakan pasangan file Compose yang sama pada operasi `up` berikutnya agar attachment tetap dideklarasikan.

Adapter polling setiap5s, timeout4s/request, satu siklus aktif. Data final sukses tetap tampil bila summary gagal; data gagal mempertahankan hasil sukses terakhir dengan status data lama. Token dibuat dalam Function server-side dan tidak dikirim ke widget. Buktikan rendering/aksesibilitas melalui modul pengujian, bukan dari keberadaan flow saja.

## Bantuan CLI tanpa layanan

Sesudah dependency host tersedia, bantuan source ini tidak memerlukan secret, browser, server, atau koneksi store:

```bash
node --import tsx src/gateway.ts --help
node --import tsx src/worker.ts --help
node --import tsx src/api.ts --help
node --import tsx src/migrate.ts --help
node --import tsx src/ops.ts --help
```

Sesudah build pengguna, bentuk compile adalah `node dist/NAMA.js --help`. Command bantuan lewat `docker compose run` tetap dapat menyalakan dependency sesuai `depends_on`; gunakan host/source untuk pemeriksaan tanpa stack, bukan menyamakan kedua bentuk tersebut.

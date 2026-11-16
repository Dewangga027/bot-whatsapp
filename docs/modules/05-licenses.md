# 05. Lisensi dan penggunaan di perusahaan

Audit ini memeriksa manifest, dua lockfile npm, beberapa teks lisensi paket terpasang, dan sumber resmi vendor. Ini bukan persetujuan legal perusahaan, audit kerentanan, atau inventaris lengkap isi image hasil build. Jangan menjalankan komponen yang belum disetujui kebijakan perusahaan.

## Keputusan deployment

Gunakan Docker Engine Community native di WSL2 Ubuntu, Docker CLI, serta plugin Compose/Buildx. Jangan menggunakan Docker Desktop, termasuk daemon Desktop yang diakses dari terminal WSL. Tidak perlu memasang GUI database atau pengelola container tambahan; pgAdmin pada profile `ops` bersifat opsional.

Penggunaan jaringan perusahaan tidak dengan sendirinya membuat semua software wajib berbayar. Yang menentukan antara lain produk, jenis organisasi, lisensi versi yang dipakai, modifikasi, distribusi, serta ketentuan layanan. Sebaliknya, label gratis atau open source tidak membebaskan kewajiban lisensi dan kebijakan IT.

Source saat audit masih memakai Redis 8.2.11 dan image gateway Puppeteer 24.38.0. Keduanya memerlukan penilaian berikut sebelum dipakai di perusahaan. Audit ini tidak mengganti backend, browser, volume, atau kontrak `AGENT.md` secara diam-diam.

| Komponen source | Lisensi atau syarat utama | Tindakan operator |
| --- | --- | --- |
| Docker Desktop | Docker Subscription Service Agreement; penggunaan profesional di organisasi besar dan instansi pemerintah memerlukan langganan | Tidak digunakan. Jalur setup hanya Engine native di WSL |
| Docker Engine/Moby, Docker CLI, Compose, Buildx | Apache-2.0 pada proyek utamanya | Dapat dipakai secara komersial sesuai lisensi; kebijakan keamanan host tetap berlaku. Ini bukan lisensi Docker Desktop atau layanan Docker Hub |
| Redis 8.2.11 | Pilihan AGPLv3, RSALv2, atau SSPLv1; kontrak proyek memilih AGPLv3 | Minta persetujuan kebijakan copyleft. Redis 8 bukan BSD dan bukan alasan otomatis harus membeli Redis Enterprise |
| PostgreSQL 18.7; pgAdmin 4 versi 9.19.0 | PostgreSQL License | Penggunaan untuk tujuan apa pun tanpa fee diizinkan dengan ketentuan notice. Lisensi komponen lain dalam image tetap berlaku |
| Node.js 24 | MIT untuk proyek utama, beserta lisensi komponen yang dibundel | Pertahankan notice; periksa komponen image ketika membuat artefak distribusi |
| BullMQ 5.81.5, ioredis 5.11.1, Fastify 5.12.8, Bull Board 9.13.2, basic-auth 6.3.1, pg 8.23.1 | MIT menurut lockfile | Yang dipakai edisi komunitas/library ini, bukan BullMQ Pro, Redis Cloud, atau produk berlangganan lain |
| Puppeteer 24.38.0 | Apache-2.0 untuk library | Lisensi library tidak mencakup seluruh browser dan dependency OS |
| `ghcr.io/puppeteer/puppeteer:24.38.0` | Image resmi menyertakan Chrome for Testing; executable Chrome dan komponen lain memiliki terms/notice tersendiri | Tinjau Chrome Terms dan isi image. Jangan menyebut image ini seluruhnya Apache-2.0 atau menyamakannya dengan Chromium murni |
| whatsapp-web.js 1.34.8 | Apache-2.0 untuk library | Tidak memberikan izin otomatis memakai atau mengotomasi layanan WhatsApp |
| `whatsapp-web.js -> node-webpmux` 3.2.1 | LGPL-3.0-or-later | Perlu penilaian copyleft dan kewajiban distribusi. Paket tetap terpasang meskipun aplikasi hanya memproses teks |
| Node-RED 5.0.9; Dashboard2 1.36.1 | Apache-2.0 untuk proyek utama/community dashboard | Tidak membutuhkan FlowFuse Cloud/Enterprise untuk smoke dashboard ini. Node tambahan pada instalasi existing perlu audit tersendiri |
| WSL, Ubuntu/Debian, kernel, utilitas dan library OS | Campuran lisensi, termasuk lisensi open source copyleft | Bukan lisensi Docker Desktop. Persetujuan Windows, distribusi OS, codec, dan kebijakan perangkat perusahaan tetap terpisah |

Docker Desktop gratis untuk bisnis kecil hanya bila jumlah pegawai kurang dari 250 **dan** pendapatan tahunan kurang dari USD 10 juta; ada kategori gratis lain seperti personal/pendidikan. Jangan memakai batas ini sebagai dasar mengaktifkan Desktop untuk proyek perusahaan. [Ketentuan resmi Docker Desktop](https://docs.docker.com/subscription/desktop-license/).

## Redis, LGPL, dan pilihan lisensi permisif

AGPL/LGPL bukan larangan penggunaan komersial atau tagihan berdasarkan jumlah pegawai. AGPLv3 pasal13 mengatur penawaran corresponding source kepada pengguna jaringan ketika program yang dicakup dimodifikasi. Ini tidak berarti semua aplikasi yang berbicara dengan Redis otomatis menjadi AGPL. Distribusi image/binary juga dapat menimbulkan kewajiban tersendiri; penilaian harus melihat penggunaan yang sebenarnya.

Untuk `node-webpmux`, LGPLv3 memuat ketentuan notice, source library, modifikasi, dan mekanisme mengganti/relink library pada distribusi combined work. Jangan menghapus file lisensi dari `node_modules`, menambahkan larangan yang bertentangan, atau menyatakan seluruh dependency proyek permisif. Penggunaan internal dan penyerahan image kepada badan hukum lain perlu dibedakan oleh penanggung jawab legal.

Jika kebijakan perusahaan menolak AGPL/RSAL/SSPL, kandidat pengganti backend ialah [Valkey dengan BSD-3-Clause](https://github.com/valkey-io/valkey/blob/8.1/COPYING). Ini **belum diterapkan**. Penggantian memerlukan keputusan kontrak, pin image yang nyata, penyesuaian CLI/entrypoint/healthcheck/backup/restore, dan pengujian BullMQ oleh pengguna. Jangan sekadar mengganti tag lalu memasang volume Redis 8 existing: kompatibilitas protokol tidak membuktikan kompatibilitas RDB/AOF atau pemulihan job. [Panduan kompatibilitas BullMQ](https://docs.bullmq.io/guide/redis-tm-compatibility).

Jika perusahaan menolak executable Chrome, kandidatnya Chromium dari distribusi Linux yang disetujui. Ini juga **belum diterapkan** dan tetap memiliki komponen dengan lisensi berbeda; memerlukan build, kecocokan Puppeteer, dan pembuktian sandbox oleh pengguna. Jangan mengatasi masalah sandbox dengan `--no-sandbox` atau privileged container.

## Risiko WhatsApp terpisah dari lisensi library

WhatsApp Web adalah layanan milik pihak lain, bukan layanan yang hak penggunaannya diberikan oleh Apache-2.0 pada whatsapp-web.js. Terms WhatsApp membatasi penggunaan non-personal yang tidak diotorisasi, akses/pengumpulan informasi yang tidak diizinkan, dan bentuk otomasi tertentu. Persetujuan internal perusahaan atau anggota grup tidak menggantikan izin yang disyaratkan penyedia layanan.

Sebelum pairing atau menjalankan profile `whatsapp`, penanggung jawab harus menilai izin penggunaan layanan yang berlaku, otorisasi nomor dan grup, pemrosesan data karyawan, serta risiko suspensi akun. Gateway tidak resmi tidak dapat dinyatakan bebas risiko kontrak. Jika persyaratan layanan tidak dapat dipenuhi, jangan aktifkan gateway ini; jalur integrasi resmi memerlukan evaluasi fitur/biaya tersendiri, bukan penggantian URL yang dijanjikan setara.

## Bukti dependency npm

| Sumber | Entri paket selain root | Cakupan |
| --- | --- | --- |
| `package-lock.json` | 365 | Termasuk dev dan paket opsional lintas platform; bukan jumlah paket dalam image Linux |
| `nodered/package-lock.json` | 177 | Dependency Dashboard2 tambahan; tidak mencakup semua paket Node-RED/base image |

Mayoritas deklarasi adalah MIT/Apache/BSD/ISC; ada juga BlueOak-1.0.0, Python-2.0, 0BSD dan Unlicense. Satu deklarasi copyleft pada lockfile root adalah `node-webpmux` 3.2.1. Tidak ada deklarasi AGPL/SSPL di kedua lockfile tersebut, tetapi Redis dan browser berada di luar cakupan ini. Deklarasi metadata bukan bukti bahwa seluruh file, WASM, binary, dan kode vendored memakai lisensi yang sama.

Dua entri root tidak memiliki field `license`. Pemeriksaan teks paket menyelesaikan celah metadata tersebut, bukan mengubah lockfile:

| Paket | Bukti file paket terpasang | Temuan |
| --- | --- | --- |
| `qrcode-terminal` 0.12.0 | `LICENSE`, `package.json` field lama `licenses` | Apache-2.0 untuk paket utama |
| Kode QR yang dibundel paket tersebut | `vendor/QRCode/index.js`, header copyright Kazuhiko Arase | MIT; pertahankan atribusi tersendiri |
| `fluent-ffmpeg/node_modules/async` 0.2.10 | `LICENSE`, `package.json` field `licenses` | MIT |

Untuk melihat ulang deklarasi tanpa instalasi tool, koneksi layanan, lifecycle npm, tes atau build, jalankan dari root proyek:

```bash
node --input-type=module -e 'import { readFileSync } from "node:fs"; for (const file of ["package-lock.json", "nodered/package-lock.json"]) { const lock = JSON.parse(readFileSync(file, "utf8")); console.log(file); for (const [path, entry] of Object.entries(lock.packages)) { if (path) console.log(`${path}\t${entry.version}\t${entry.license ?? "PERIKSA TEKS LISENSI"}`); } }'
```

Setelah perubahan versi, ulangi pemeriksaan teks lisensi untuk entri kosong, copyleft, lisensi khusus, dan binary/kode vendored. Jangan membuat override metadata untuk menyembunyikan temuan.

## Registry dan penerapan perusahaan

Docker Engine open source tidak berarti layanan Docker Hub memiliki akses tak terbatas. Pull dari satu IP keluar kantor dapat berbagi rate limit; registry mempunyai terms, fair use dan autentikasi sendiri. Gunakan akun atau mirror internal yang disetujui IT dan simpan digest. Jangan mengganti registry dengan mirror tidak tepercaya atau mematikan verifikasi TLS untuk melewati proxy. Tidak perlu Docker Build Cloud, Docker Scout, Docker Desktop, atau layanan FlowFuse berbayar untuk prosedur proyek ini.

Sebelum persetujuan operasional, IT/legal menetapkan penggunaan yang diizinkan untuk Redis AGPL, LGPL transitive, browser, WhatsApp, registry, dan distribusi artefak. Catat versi/digest, penggunaan internal atau distribusi, perubahan pada komponen pihak ketiga, serta kewajiban notice/source. Bila ada larangan yang belum diselesaikan, hentikan langkah terkait pada modul setup maupun pengujian. Dokumen ini tidak mencentang persetujuan atas nama pengguna.

## Batas pemeriksaan dan sumber

Audit tidak memasang, mencopot atau mengubah software host. Pemeriksaan metadata daemon WSL menunjukkan Ubuntu 26.04 LTS, root Docker `/var/lib/docker`, context `default` dengan endpoint `unix:///var/run/docker.sock`, dan paket native `docker-ce`/`docker-ce-cli` 29.9.2, `docker-compose-plugin` 5.6.1, `docker-buildx-plugin` 0.38.1, `containerd.io` 2.4.2. Ini bukti daemon yang diperiksa, bukan bukti Docker Desktop tidak terpasang di Windows atau jaminan context tidak akan berubah.

Tidak ada tes/build, pull/build image, startup stack, migrasi, pairing, akses isi volume/data operasional, atau pemindaian seluruh paket image. Audit isi image hasil build dan instalasi Node-RED existing belum tersedia; periksa sebelum distribusi atau penetapan patuh perusahaan. Tidak ada lisensi baru yang ditetapkan untuk source proyek sendiri.

Sumber primer:

- [Docker Engine pada Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [Moby LICENSE](https://github.com/moby/moby/blob/master/LICENSE), [CLI LICENSE](https://github.com/docker/cli/blob/master/LICENSE), [Compose LICENSE](https://github.com/docker/compose/blob/main/LICENSE), [Buildx LICENSE](https://github.com/docker/buildx/blob/master/LICENSE).
- [Docker Hub usage/limits](https://docs.docker.com/docker-hub/usage/). Ketentuan registry terpisah dari lisensi Engine dan image.
- [Redis licensing/version matrix](https://redis.io/legal/licenses/), [AGPLv3 pasal13](https://www.gnu.org/licenses/agpl-3.0.en.html#section13), [LGPLv3](https://www.gnu.org/licenses/lgpl-3.0.en.html).
- [PostgreSQL License](https://www.postgresql.org/about/licence/), [pgAdmin License](https://www.pgadmin.org/licence/), [Node.js LICENSE](https://github.com/nodejs/node/blob/v24.22.3/LICENSE).
- [Puppeteer Docker: Chrome for Testing](https://pptr.dev/guides/docker), [Chrome Terms](https://www.google.com/chrome/terms/).
- [whatsapp-web.js 1.34.8](https://github.com/wwebjs/whatsapp-web.js/tree/v1.34.8), teks `node_modules/whatsapp-web.js/LICENSE`, `node_modules/node-webpmux/COPYING.LESSER`, [WhatsApp Terms](https://www.whatsapp.com/legal/terms-of-service).
- [Node-RED LICENSE](https://github.com/node-red/node-red/blob/master/LICENSE), [Dashboard2 LICENSE](https://github.com/FlowFuse/node-red-dashboard/blob/main/LICENSE), serta deklarasi versi terkunci pada kedua lockfile proyek.

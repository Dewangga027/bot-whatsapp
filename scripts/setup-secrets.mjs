import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const secretNames = [
  'redis-password',
  'postgres-admin-password',
  'postgres-worker-password',
  'postgres-reader-password',
  'api-read-token',
  'ops-password',
  'pgadmin-password',
];

function protectWindows(path, directory) {
  const script = `
    $ErrorActionPreference = 'Stop'
    $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $isDirectory = $env:MONITORING_ACL_DIRECTORY -eq 'true'
    if ($isDirectory) {
      $acl = [System.Security.AccessControl.DirectorySecurity]::new()
      $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
      $acl = [System.Security.AccessControl.FileSecurity]::new()
      $inherit = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($owner)
    foreach ($identity in @($owner, $system)) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity, 'FullControl', $inherit, 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $env:MONITORING_ACL_PATH -AclObject $acl
    $saved = Get-Acl -LiteralPath $env:MONITORING_ACL_PATH
    if (-not $saved.AreAccessRulesProtected) { throw 'ACL inheritance active' }
    foreach ($rule in $saved.Access) {
      $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      if ($sid -ne $owner.Value -and $sid -ne $system.Value) { throw 'Unexpected ACL identity' }
    }
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, MONITORING_ACL_PATH: path, MONITORING_ACL_DIRECTORY: String(directory) },
    stdio: 'ignore',
  });
  if (result.status !== 0) throw new Error('ACL Windows tidak dapat dilindungi.');
}

async function requireNativeStorage(path) {
  if (process.platform !== 'linux') throw new Error('Pemeriksaan filesystem membutuhkan Linux.');
  const target = await realpath(path);
  const result = spawnSync('findmnt', [
    '--kernel', '--noheadings', '--raw', '--first-only',
    '--target', target, '--output', 'FSTYPE,SOURCE',
  ], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) throw new Error('Sumber filesystem tidak dapat diperiksa.');
  const fields = result.stdout.trim().split(/\s+/);
  if (fields.length !== 2) throw new Error('Sumber filesystem ambigu.');
  const [type, source] = fields;
  console.log(`Filesystem penyimpanan: type=${type}, source=${source}`);
  // Mode DrvFS hanya metadata Linux; bind mount juga harus diperiksa melalui mount table.
  if (!['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'zfs'].includes(type)) {
    throw new Error('Pilih penyimpanan Linux native, bukan filesystem Windows atau shared mount.');
  }
}

async function prepareDirectory(path) {
  if (process.platform !== 'win32') await requireNativeStorage(dirname(path));
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error('Direktori secrets harus direktori biasa.');
  }
  if (process.platform !== 'win32') await requireNativeStorage(path);
  const entries = await readdir(path);
  if (entries.some((name) => !secretNames.includes(name))) {
    throw new Error('Direktori secret berisi file di luar daftar secret aplikasi.');
  }
  if (process.platform === 'win32') {
    // ACL direktori diwariskan file baru; tidak mengubah isi secret yang sudah ada.
    protectWindows(path, true);
  } else if ((status.mode & 0o777) !== 0o700 || status.uid !== process.getuid()) {
    throw new Error('Direktori secrets existing harus dimiliki operator dengan mode 0700.');
  }
}

async function createSecret(path) {
  let file;
  try {
    file = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || status.size === 0) {
      throw new Error('Secret existing bukan file biasa nonkosong.');
    }
    if (process.platform !== 'win32') await requireNativeStorage(path);
    if (process.platform !== 'win32' && ((status.mode & 0o777) !== 0o444 || status.uid !== process.getuid())) {
      throw new Error('Izin secret existing tidak cocok dengan mount nonroot.');
    }
    if (process.platform === 'win32') protectWindows(path, false);
    return false;
  }
  try {
    await file.writeFile(`${randomBytes(32).toString('hex')}\n`);
    await file.sync();
    // Compose lokal mempertahankan inode host; UID runtime berbeda perlu akses baca.
    // Direktori 0700 membatasi host, tiap service hanya mendapat mount secret sendiri.
    if (process.platform !== 'win32') {
      await file.chmod(0o444);
      const status = await file.stat();
      if ((status.mode & 0o777) !== 0o444 || status.uid !== process.getuid()) {
        throw new Error('Filesystem tidak menerapkan izin secret.');
      }
    } else {
      protectWindows(path, false);
    }
  } finally {
    await file.close();
  }
  return true;
}

async function setup(directory) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const secrets = resolve(root, directory);
  if (/[\r\n']/.test(secrets)) throw new Error('Path secret tidak didukung.');
  if (secrets === root || dirname(secrets) === secrets) throw new Error('Pilih direktori khusus secret.');
  await prepareDirectory(secrets);
  let created = 0;
  for (const name of secretNames) {
    if (await createSecret(join(secrets, name))) created += 1;
  }
  let envFile;
  try {
    envFile = await open(join(root, '.env'), 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (envFile !== undefined) {
    try {
      const example = await readFile(join(root, '.env.example'), 'utf8');
      const contents = example.replace(/^SECRETS_DIR=.*$/m, () => `SECRETS_DIR='${secrets.replaceAll('\\', '/')}'`);
      await envFile.writeFile(contents);
      await envFile.sync();
      if (process.platform === 'win32') protectWindows(join(root, '.env'), false);
    } finally {
      await envFile.close();
    }
  }
  console.log(`Secret baru: ${created}; file existing dipertahankan. Nilai secret tidak ditampilkan.`);
  console.log('Pastikan SECRETS_DIR pada .env existing menunjuk direktori yang dipilih.');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    console.log('Pemakaian: node scripts/setup-secrets.mjs create [--directory PATH]\nMembuat secret acak dan .env hanya jika belum ada. Default direktori: SECRETS_DIR atau ./secrets.\nLinux memerlukan findmnt dan filesystem native: ext2/ext3/ext4/xfs/btrfs/f2fs/zfs, direktori0700, file0444.\nDrvFS/Windows/shared mount ditolak meskipun mode0700 terlihat; gunakan --directory \"$HOME/monitoring-secrets\" pada filesystem Linux native.\nNative Windows: ACL operator+SYSTEM. Tidak menjalankan Docker.');
    return;
  }
  if (args[0] !== 'create' || !(args.length === 1 || (args.length === 3 && args[1] === '--directory' && args[2] !== ''))) {
    console.error('Perintah tidak dikenal. Gunakan --help atau create.');
    process.exitCode = 1;
    return;
  }
  try {
    await setup(args[2] ?? process.env.SECRETS_DIR ?? 'secrets');
  } catch {
    console.error('Setup gagal; file yang sudah dibuat dipertahankan. Periksa izin/ACL tanpa mencetak secret. Linux membutuhkan findmnt dan penyimpanan native; DrvFS/Windows/shared mount ditolak termasuk mode metadata. Gunakan --directory \"$HOME/monitoring-secrets\" pada filesystem Linux native dan atur SECRETS_DIR.');
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();

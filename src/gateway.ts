import type { Message } from 'whatsapp-web.js';
import { loadConfig } from './config.js';
import type { ServiceConfig } from './config.js';
import { isChecklistMessage } from './parser.js';
import type { IncomingMessage } from './types.js';

type GatewayMessage = Pick<
  Message,
  'fromMe' | 'hasMedia' | 'from' | 'to' | 'id' | 'author' | 'timestamp' | 'body'
> & { type: string };

const SAFE_REASONS: Record<string, true> = {
  CONFLICT: true,
  CONNECTED: true,
  DEPRECATED_VERSION: true,
  LOGOUT: true,
  OPENING: true,
  PAIRING: true,
  PROXYBLOCK: true,
  SMB_TOS_BLOCK: true,
  TIMEOUT: true,
  TOS_BLOCK: true,
  UNLAUNCHED: true,
  UNPAIRED: true,
  UNPAIRED_IDLE: true,
};

function sanitizeReason(reason: string): string {
  if (Object.hasOwn(SAFE_REASONS, reason)) {
    return reason;
  }
  if (reason === 'Max qrcode retries reached') {
    return 'QR_RETRIES_EXHAUSTED';
  }
  return 'UNKNOWN';
}

function allowedChatId(message: GatewayMessage, allowedGroupIds: ReadonlySet<string>): string | null {
  const chatId = message.fromMe || message.id.fromMe ? message.to : message.from;
  return !message.hasMedia && message.type === 'chat' && chatId.endsWith('@g.us') && allowedGroupIds.has(chatId)
    ? chatId : null;
}

export function shouldReplyToPing(message: GatewayMessage, allowedGroupIds: ReadonlySet<string>): boolean {
  return (message.fromMe || message.id.fromMe) && message.body === '!ping'
    && allowedChatId(message, allowedGroupIds) !== null;
}

export function toIncomingMessage(
  message: GatewayMessage,
  sessionKey: string,
  allowedGroupIds: ReadonlySet<string>,
  receivedAt: string,
): IncomingMessage | null {
  const chatId = allowedChatId(message, allowedGroupIds);
  if (chatId === null || !isChecklistMessage(message.body)) {
    return null;
  }
  return {
    session_key: sessionKey,
    message_id: message.id._serialized,
    source_timestamp: message.timestamp,
    chat_id: chatId,
    sender_id: message.author ?? null,
    received_at: receivedAt,
    raw_body: message.body,
    message_type: message.type,
  };
}

export async function startGateway(
  config?: Extract<ServiceConfig, { service: 'gateway' }>,
): Promise<void> {
  const settings = config ?? loadConfig('gateway');
  if (settings.service !== 'gateway') {
    throw new Error('Konfigurasi gateway diperlukan');
  }
  if (settings.pairingMode && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Pairing wajib dijalankan di terminal foreground interaktif');
  }
  if (!settings.pairingMode && settings.allowedGroupIds.length === 0) {
    throw new Error('Gateway memerlukan ALLOWED_GROUP_IDS yang tidak kosong');
  }

  const [{ default: whatsapp }, { default: puppeteer }, { default: qr }, queueModule] = await Promise.all([
    import('whatsapp-web.js'),
    import('puppeteer'),
    import('qrcode-terminal'),
    import('./queue.js'),
  ]);
  const browserAbort = new AbortController();
  const client = new whatsapp.Client({
    authTimeoutMs: 120_000,
    authStrategy: new whatsapp.LocalAuth({ clientId: 'monitoring', dataPath: '/data/wwebjs-auth' }),
    puppeteer: {
      executablePath: puppeteer.executablePath(),
      headless: true,
      signal: browserAbort.signal,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    },
  });
  const queue = settings.pairingMode ? undefined : queueModule.createQueue(settings.redis);
  const allowedGroupIds = new Set(settings.allowedGroupIds);
  const sessionKey = settings.sessionKey;
  const inFlight = new Set<Promise<string | void>>();
  const stopped = Promise.withResolvers<void>();
  let stopping = false;
  let failure: Error | undefined;
  let pairing: Promise<void> | undefined;

  function requestStop(error?: Error): void {
    if (stopping) {
      return;
    }
    stopping = true;
    failure = error;
    stopped.resolve();
  }

  function onSignal(): void {
    requestStop();
  }

  function onMessage(message: Message): void {
    if (stopping || queue === undefined) {
      return;
    }
    if (shouldReplyToPing(message, allowedGroupIds)) {
      const pending = message.reply('pong')
        .then(() => { console.log('PONG_SENT'); })
        .catch(() => { console.error('PONG_FAILED'); })
        .finally(() => { inFlight.delete(pending); });
      inFlight.add(pending);
      return;
    }
    const incoming = toIncomingMessage(message, sessionKey, allowedGroupIds, new Date().toISOString());
    if (incoming === null) {
      return;
    }
    const pending = queueModule.enqueueMessage(incoming, queue)
      .then(jobId => { console.log(`STAGED: ${jobId}`); })
      .catch(function notStaged() {
        console.error('NOT_STAGED: pesan tidak tersimpan di Redis; tidak ada retry otomatis.');
      })
      .finally(function settled() {
        inFlight.delete(pending);
      });
    inFlight.add(pending);
  }

  async function showGroups(): Promise<void> {
    try {
      const chats = await client.getChats();
      if (stopping) {
        return;
      }
      console.log('Pairing tersimpan. Pilih ID grup untuk ALLOWED_GROUP_IDS:');
      for (const chat of chats) {
        if (chat.isGroup) {
          console.log(JSON.stringify({ id: chat.id._serialized, name: chat.name }));
        }
      }
      requestStop();
    } catch {
      if (!stopping) {
        console.error('Daftar grup tidak dapat dibaca. Jalankan pairing foreground kembali.');
        requestStop(new Error('Daftar grup tidak tersedia'));
      }
    }
  }

  client.on('qr', function onQr(value: string) {
    if (stopping) {
      return;
    }
    if (settings.pairingMode) {
      console.log('Pindai QR melalui WhatsApp > Perangkat tertaut. Jangan bagikan QR ini.');
      qr.generate(value, { small: true });
      return;
    }
    console.error('Sesi WhatsApp perlu pairing. Hentikan gateway, lalu jalankan PAIRING_MODE=true di terminal foreground.');
    requestStop(new Error('Pairing diperlukan'));
  });
  client.on('authenticated', function onAuthenticated() {
    if (!stopping) {
      console.log('Autentikasi WhatsApp berhasil; menunggu ready.');
    }
  });
  client.on('ready', function onReady() {
    if (stopping) {
      return;
    }
    if (settings.pairingMode) {
      pairing ??= showGroups();
      return;
    }
    console.log('Gateway WhatsApp siap menerima checklist dari grup yang diizinkan.');
  });
  client.on('auth_failure', function onAuthFailure(reason: string) {
    if (!stopping) {
      console.error(`Autentikasi WhatsApp gagal (${sanitizeReason(reason)}). Jalankan pairing foreground.`);
      requestStop(new Error('Autentikasi WhatsApp gagal'));
    }
  });
  client.on('disconnected', function onDisconnected(reason: string) {
    if (!stopping) {
      console.error(`WhatsApp terputus (${sanitizeReason(reason)}).`);
      requestStop(new Error('WhatsApp terputus'));
    }
  });
  if (!settings.pairingMode) {
    client.on('message_create', onMessage);
  }
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);

  const initialization = client.initialize().catch(function initializationFailed() {
    if (!stopping) {
      console.error('Inisialisasi WhatsApp gagal. Periksa sesi, jaringan, dan sandbox browser.');
      requestStop(new Error('Inisialisasi WhatsApp gagal'));
    }
  });
  try {
    await stopped.promise;
  } finally {
    client.removeListener('message_create', onMessage);
    await Promise.allSettled(inFlight);
    try {
      if (!client.pupBrowser) {
        browserAbort.abort();
        await initialization;
      }
      await client.destroy();
      await initialization;
      await pairing;
    } catch {
      console.error('Browser WhatsApp tidak dapat ditutup dengan bersih.');
      failure ??= new Error('Penutupan browser gagal');
    } finally {
      try {
        await queue?.close();
      } catch {
        console.error('Koneksi antrean gateway tidak dapat ditutup dengan bersih.');
        failure ??= new Error('Penutupan antrean gagal');
      } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('SIGHUP', onSignal);
        client.removeAllListeners();
      }
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Pemakaian: node dist/gateway.js\n\nMode normal: ALLOWED_GROUP_IDS wajib berisi ID grup.\nPairing: hentikan gateway, lalu jalankan PAIRING_MODE=true di terminal foreground interaktif.\nPairing hanya menampilkan QR dan daftar grup, tanpa memasukkan pesan ke antrean.');
  } else if (args.length > 0) {
    console.error('Argumen tidak dikenal. Gunakan --help.');
    process.exitCode = 1;
  } else {
    try {
      await startGateway();
    } catch {
      console.error('Gateway berhenti karena kegagalan konfigurasi atau layanan. Periksa pesan status yang tersanitasi.');
      process.exitCode = 1;
    }
  }
}

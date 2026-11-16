import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toIncomingMessage } from '../src/gateway.js';

type GatewayMessage = Parameters<typeof toIncomingMessage>[0];
const receivedAt = '2026-11-16T08:00:01.234Z';
const allowedGroupIds = new Set(['120363000000001@g.us']);
const message: GatewayMessage = Object.freeze({
  fromMe: false,
  hasMedia: false,
  type: 'chat',
  from: '120363000000001@g.us',
  id: Object.freeze({
    fromMe: false,
    remote: '120363000000001@g.us',
    id: 'ABCDEF',
    _serialized: 'true_120363000000001@g.us_ABCDEF',
  }),
  author: '123456789@lid',
  timestamp: 1794816000,
  body: '\r\n Monitoring drawdown \r\nMesin filling: I\r\nKetebalan: 8,0\r\nTekanan: 2,9\r\nVacuum: -0,5\r\nKeterangan: Kondisi bagus  ',
});

test('preserves raw metadata and body without deriving fromMe from serialized ID', () => {
  const before = structuredClone(message);
  const result = toIncomingMessage(message, 'report-identity', allowedGroupIds, receivedAt);
  assert.deepEqual(result, {
    session_key: 'report-identity',
    message_id: 'true_120363000000001@g.us_ABCDEF',
    source_timestamp: 1794816000,
    chat_id: '120363000000001@g.us',
    sender_id: '123456789@lid',
    received_at: '2026-11-16T08:00:01.234Z',
    raw_body: '\r\n Monitoring drawdown \r\nMesin filling: I\r\nKetebalan: 8,0\r\nTekanan: 2,9\r\nVacuum: -0,5\r\nKeterangan: Kondisi bagus  ',
    message_type: 'chat',
  });
  assert.deepEqual(message, before);
});

test('keeps missing author null instead of inferring a phone number', () => {
  const { author, ...withoutAuthor } = message;
  const result = toIncomingMessage(withoutAuthor, 'monitoring', allowedGroupIds, receivedAt);
  assert.ok(result);
  assert.equal(result.sender_id, null);
});

const rejectedCases: { name: string; changes: Partial<GatewayMessage> }[] = [
  { name: 'message fromMe metadata', changes: { fromMe: true } },
  { name: 'ID fromMe metadata', changes: { id: { ...message.id, fromMe: true } } },
  { name: 'media caption', changes: { hasMedia: true } },
  { name: 'image even without downloadable media', changes: { type: 'image' } },
  { name: 'private chat', changes: { from: '123456789@c.us' } },
  { name: 'unlisted group', changes: { from: '120363000000002@g.us' } },
  { name: 'ordinary chat', changes: { body: 'Selamat pagi' } },
  { name: 'header appearing after ordinary text', changes: { body: 'Selamat pagi\nMonitoring drawdown' } },
  { name: 'header with extra text', changes: { body: 'Monitoring drawdown tambahan' } },
  { name: 'empty body', changes: { body: '' } },
];

for (const { name, changes } of rejectedCases) {
  test(`ignores ${name}`, () => {
    assert.equal(toIncomingMessage({ ...message, ...changes }, 'monitoring', allowedGroupIds, receivedAt), null);
  });
}

test('does not admit a private chat even when a caller includes its ID in the allowlist', () => {
  assert.equal(toIncomingMessage(
    { ...message, from: '123456789@c.us' },
    'monitoring',
    new Set(['123456789@c.us']),
    receivedAt,
  ), null);
});

test('admits header candidates without prematurely rejecting malformed checklist fields', () => {
  const result = toIncomingMessage(
    { ...message, body: '\r\n MONITORING DRAWDOWN \r\nKetebalan: salah' },
    'monitoring',
    allowedGroupIds,
    receivedAt,
  );
  assert.ok(result);
  assert.equal(result.raw_body, '\r\n MONITORING DRAWDOWN \r\nKetebalan: salah');
});

test('empty allowlist never admits a checklist', () => {
  assert.equal(toIncomingMessage(message, 'monitoring', new Set(), receivedAt), null);
});

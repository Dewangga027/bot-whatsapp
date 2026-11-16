import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isChecklistMessage, parseChecklist } from '../src/parser.js';

const messageI = `Monitoring drawdown
Mesin filling: I
Ketebalan: 8,0
Tekanan: 2,9
Vacuum: -0,5
Keterangan: Kondisi bagus`;
const messageG = messageI.replace('filling: I', 'filling: G')
  .replace('8,0', '8.3').replace('2,9', '3').replace('-0,5', '-0.2');

function assertInvalid(body: string, code: string, field: string): void {
  const result = parseChecklist(body);
  assert.equal(result.ok, false);
  assert.equal('value' in result, false);
  if (result.ok) {
    assert.fail('Expected invalid checklist');
  }
  assert.ok(result.errors.some((error) => error.code === code && error.field === field));
}

test('parses the complete I example without changing machine or decimal precision', () => {
  assert.deepEqual(parseChecklist(messageI), {
    ok: true,
    value: { machine: 'I', thickness: '8.0', pressure: '2.9', vacuum: '-0.5', notes: 'Kondisi bagus' },
  });
});

test('parses the G example without imposing machine limits or units', () => {
  assert.deepEqual(parseChecklist(messageG), {
    ok: true,
    value: { machine: 'G', thickness: '8.3', pressure: '3', vacuum: '-0.2', notes: 'Kondisi bagus' },
  });
});

test('recognizes only an exact trimmed case-insensitive first nonempty header', () => {
  assert.equal(isChecklistMessage('\r\n  MONITORING DRAWDOWN \r\nMesin filling: I'), true);
  assert.equal(isChecklistMessage('obrolan biasa\nMonitoring drawdown'), false);
  assert.equal(isChecklistMessage(''), false);
  assert.equal(isChecklistMessage(' \r\n\t'), false);
  assert.equal(isChecklistMessage('Monitoring drawdown extra'), false);
  assert.equal(isChecklistMessage('Monitoring  drawdown'), false);
});

test('accepts reordered fields, CRLF, blank lines, and normalized labels', () => {
  const body = '\r\n MONITORING DRAWDOWN \r\n\r\n kEtErAnGaN : Kondisi bagus \r\n VACUUM: -0,5\r\n  mesin\t filling : I \r\n tekanan : 2,9\r\n\t\r\n KETEBALAN : 8,0\r\n';
  assert.deepEqual(parseChecklist(body), {
    ok: true,
    value: { machine: 'I', thickness: '8.0', pressure: '2.9', vacuum: '-0.5', notes: 'Kondisi bagus' },
  });
});

for (const [label, value] of [
  ['Mesin filling', 'I'], ['Ketebalan', '8,0'], ['Tekanan', '2,9'],
  ['Vacuum', '-0,5'], ['Keterangan', 'Kondisi bagus'],
]) {
  test(`reports missing ${label}`, () => {
    assertInvalid(messageI.replace(`\n${label}: ${value}`, ''), 'MISSING_FIELD', label);
  });
  test(`reports empty ${label} rather than accepting a partial payload`, () => {
    assertInvalid(messageI.replace(`${label}: ${value}`, `${label}: \t`), 'EMPTY_FIELD', label);
  });
  test(`rejects duplicate ${label}`, () => {
    assertInvalid(`${messageI}\n${label}: ${value}`, 'DUPLICATE_FIELD', label);
  });
}

test('detects duplicates after case and whitespace normalization', () => {
  assertInvalid(`${messageI}\n MESIN\t  FILLING : G`, 'DUPLICATE_FIELD', 'MESIN\t  FILLING');
});

test('rejects unknown labels including object prototype names', () => {
  for (const label of ['Suhu', '__proto__', 'constructor', 'toString']) {
    assertInvalid(`${messageI}\n${label}: 1`, 'UNKNOWN_FIELD', label);
  }
});

test('reports malformed lines and invalid headers', () => {
  assertInvalid(`${messageI}\nbaris tanpa pemisah`, 'MALFORMED_LINE', 'pesan');
  assertInvalid(`${messageI}\n: nilai`, 'MALFORMED_LINE', 'pesan');
  for (const body of ['', ' \r\n', messageI.replace('Monitoring drawdown', 'obrolan biasa'), `obrolan\n${messageI}`]) {
    assertInvalid(body, 'INVALID_HEADER', 'pesan');
  }
});

for (const [label, original] of [['Ketebalan', '8,0'], ['Tekanan', '2,9'], ['Vacuum', '-0,5']]) {
  for (const invalid of ['8mm', '1e3', 'NaN', 'Infinity', '1,2.3', '--1', '.5', '1.', '9'.repeat(400), '0.' + '0'.repeat(400) + '1']) {
    test(`rejects invalid decimal ${invalid.length > 30 ? invalid.slice(0, 12) + '...' : invalid} in ${label}`, () => {
      assertInvalid(messageI.replace(`${label}: ${original}`, `${label}: ${invalid}`), 'INVALID_DECIMAL', label);
    });
  }
}

test('preserves signs, leading and trailing zeros, and unrounded decimal digits', () => {
  const body = messageI.replace('8,0', '+0008,300').replace('2,9', '1.234567890123456789');
  assert.deepEqual(parseChecklist(body), {
    ok: true,
    value: { machine: 'I', thickness: '+0008.300', pressure: '1.234567890123456789', vacuum: '-0.5', notes: 'Kondisi bagus' },
  });
});

test('accepts zero including negative zero and arbitrarily long zero fractions', () => {
  const zero = '0.' + '0'.repeat(400);
  assert.deepEqual(parseChecklist(messageI.replace('8,0', zero).replace('2,9', '+000').replace('-0,5', '-0')), {
    ok: true,
    value: { machine: 'I', thickness: zero, pressure: '+000', vacuum: '-0', notes: 'Kondisi bagus' },
  });
});

test('splits at the first colon and preserves notes content', () => {
  assert.deepEqual(parseChecklist(messageI.replace('Kondisi bagus', 'cek: <b>aman</b>')), {
    ok: true,
    value: { machine: 'I', thickness: '8.0', pressure: '2.9', vacuum: '-0.5', notes: 'cek: <b>aman</b>' },
  });
});

test('collects independent errors without a valid partial payload', () => {
  const result = parseChecklist('Monitoring drawdown\nMesin filling: I\nKetebalan: nope\nTekanan: \nSuhu: 5\nrusak');
  assert.equal(result.ok, false);
  assert.equal('value' in result, false);
  if (result.ok) {
    assert.fail('Expected invalid checklist');
  }
  assert.deepEqual(result.errors.map(({ code, field }) => ({ code, field })), [
    { code: 'INVALID_DECIMAL', field: 'Ketebalan' },
    { code: 'EMPTY_FIELD', field: 'Tekanan' },
    { code: 'UNKNOWN_FIELD', field: 'Suhu' },
    { code: 'MALFORMED_LINE', field: 'pesan' },
    { code: 'MISSING_FIELD', field: 'Vacuum' },
    { code: 'MISSING_FIELD', field: 'Keterangan' },
  ]);
});

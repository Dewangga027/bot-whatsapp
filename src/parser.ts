import type { ParsedChecklist, ParseResult, ValidationError } from './types.js';

const HEADER = 'monitoring drawdown';
const DECIMAL = /^[+-]?[0-9]+(?:[.,][0-9]+)?$/;
const FIELDS = new Map<string, { label: string; field: keyof ParsedChecklist }>([
  ['mesin filling', { label: 'Mesin filling', field: 'machine' }],
  ['ketebalan', { label: 'Ketebalan', field: 'thickness' }],
  ['tekanan', { label: 'Tekanan', field: 'pressure' }],
  ['vacuum', { label: 'Vacuum', field: 'vacuum' }],
  ['keterangan', { label: 'Keterangan', field: 'notes' }],
]);

export function isChecklistMessage(body: string): boolean {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      return trimmed.toLowerCase() === HEADER;
    }
  }
  return false;
}

export function parseChecklist(body: string): ParseResult {
  const errors: ValidationError[] = [];
  const seen = new Set<keyof ParsedChecklist>();
  const parsed: ParsedChecklist = { machine: '', thickness: '', pressure: '', vacuum: '', notes: '' };
  let headerSeen = false;

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    if (!headerSeen) {
      headerSeen = true;
      if (trimmed.toLowerCase() !== HEADER) {
        errors.push({ field: 'pesan', code: 'INVALID_HEADER', message: 'Judul harus Monitoring drawdown.' });
      }
      continue;
    }

    const separator = trimmed.indexOf(':');
    const label = trimmed.slice(0, separator).trim();
    if (separator < 0 || label === '') {
      errors.push({ field: 'pesan', code: 'MALFORMED_LINE', message: 'Baris harus berisi label dan nilai yang dipisahkan titik dua.' });
      continue;
    }
    const definition = FIELDS.get(label.replace(/\s+/g, ' ').toLowerCase());
    if (!definition) {
      errors.push({ field: label, code: 'UNKNOWN_FIELD', message: 'Label tidak dikenal.' });
      continue;
    }
    const { field } = definition;
    if (seen.has(field)) {
      errors.push({ field: label, code: 'DUPLICATE_FIELD', message: 'Label hanya boleh muncul satu kali.' });
      continue;
    }
    seen.add(field);
    const value = trimmed.slice(separator + 1).trim();
    if (value === '') {
      errors.push({ field: label, code: 'EMPTY_FIELD', message: 'Nilai tidak boleh kosong.' });
      continue;
    }
    if (field === 'thickness' || field === 'pressure' || field === 'vacuum') {
      const normalized = value.replace(',', '.');
      const numeric = Number(normalized);
      if (!DECIMAL.test(value) || !Number.isFinite(numeric) || (numeric === 0 && /[1-9]/.test(value))) {
        errors.push({ field: label, code: 'INVALID_DECIMAL', message: 'Nilai harus desimal tanpa satuan, berhingga, dan tidak mengecil menjadi nol.' });
        continue;
      }
      parsed[field] = normalized;
    } else {
      parsed[field] = value;
    }
  }

  if (!headerSeen) {
    errors.push({ field: 'pesan', code: 'INVALID_HEADER', message: 'Judul harus Monitoring drawdown.' });
  }
  for (const { label, field } of FIELDS.values()) {
    if (!seen.has(field)) {
      errors.push({ field: label, code: 'MISSING_FIELD', message: 'Label wajib belum tersedia.' });
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: parsed };
}

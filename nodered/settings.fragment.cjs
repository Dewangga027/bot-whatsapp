'use strict';

const { readFileSync } = require('node:fs');

function readApiToken() {
  const path = process.env.API_READ_TOKEN_FILE;
  if (!path) {
    throw new Error('API_READ_TOKEN_FILE wajib diatur untuk adapter monitoring');
  }
  let token;
  try {
    token = readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error('Token baca API monitoring tidak dapat dibaca');
  }
  if (!token || /\s/.test(token)) {
    throw new Error('Token baca API monitoring tidak valid');
  }
  return token;
}

if (typeof fetch !== 'function' || typeof AbortController !== 'function') {
  throw new Error('Adapter monitoring membutuhkan Node.js dengan fetch dan AbortController');
}

// Gabungkan hanya functionGlobalContext; pertahankan adminAuth, credentialSecret, dan httpRoot existing.
module.exports = {
  functionGlobalContext: {
    monitoringApiReadToken: readApiToken(),
    monitoringHttp: Object.freeze({ fetch, AbortController, URL }),
  },
};

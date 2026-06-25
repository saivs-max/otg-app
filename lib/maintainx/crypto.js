// lib/maintainx/crypto.js
//
// AES-256-GCM encryption for per-worker MaintainX tokens at rest. We never
// store a worker's API token in plaintext and never return it to the client.
//
// Key resolution order:
//   1. process.env.MX_TOKEN_ENC_KEY  — 64 hex chars (32 bytes) preferred; any
//      other string is stretched to 32 bytes via scrypt.
//   2. data/.mx_enc_key              — a 32-byte random key generated on first
//      use and persisted with 0600 perms (dev/single-host fallback).
//
// Ciphertext format (string):  "v1:" + base64(iv) + ":" + base64(tag) + ":" + base64(ct)
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const KEY_FILE = path.join(__dirname, '..', '..', 'data', '.mx_enc_key');
const ALGO = 'aes-256-gcm';
let _key = null;

function resolveKey() {
  if (_key) return _key;
  const env = process.env.MX_TOKEN_ENC_KEY;
  if (env && /^[0-9a-fA-F]{64}$/.test(env)) {
    _key = Buffer.from(env, 'hex');
    return _key;
  }
  if (env) {
    // Non-hex secret: stretch deterministically to 32 bytes.
    _key = crypto.scryptSync(env, 'maintainx-token-enc', 32);
    return _key;
  }
  // Persisted random key fallback.
  try {
    if (fs.existsSync(KEY_FILE)) {
      const raw = fs.readFileSync(KEY_FILE);
      if (raw.length === 32) { _key = raw; return _key; }
    }
  } catch (_) { /* fall through to generate */ }
  _key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEY_FILE, _key, { mode: 0o600 });
    console.warn('[maintainx] MX_TOKEN_ENC_KEY not set — generated a local key at data/.mx_enc_key. ' +
                 'Set MX_TOKEN_ENC_KEY in production so tokens survive redeploys and stay consistent across hosts.');
  } catch (e) {
    console.warn('[maintainx] could not persist token key:', e.message);
  }
  return _key;
}

function encrypt(plaintext) {
  if (plaintext == null) throw new Error('encrypt: nothing to encrypt');
  const key = resolveKey();
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv(ALGO, key, iv);
  const ct  = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(blob) {
  if (!blob || typeof blob !== 'string') throw new Error('decrypt: empty');
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('decrypt: bad format');
  const key = resolveKey();
  const iv  = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct  = Buffer.from(parts[3], 'base64');
  const d   = crypto.createDecipheriv(ALGO, key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// Same masking convention used by routes/settings.js.
function mask(v) {
  if (!v) return null;
  if (v.length <= 6) return '••••';
  return v.slice(0, 3) + '••••' + v.slice(-2);
}

module.exports = { encrypt, decrypt, mask };

#!/usr/bin/env node
/**
 * Decrypts a client's babyai.log — the only way to read it, by design (see
 * main.js's `log()`, which encrypts every line with a PUBLIC key baked into
 * the app). Requires the matching PRIVATE key, which lives only on the
 * developer's own machine and is never shipped in any build.
 *
 * Usage:
 *   node scripts/decrypt-log.js <path-to-babyai.log> [path-to-private-key.pem]
 * Defaults to ~/.babyai-secrets/log-private-key.pem if the second argument
 * is omitted.
 */
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');

const [, , logPath, keyPathArg] = process.argv;
const keyPath = keyPathArg || path.join(os.homedir(), '.babyai-secrets', 'log-private-key.pem');

if (!logPath) {
  console.error('Usage: node scripts/decrypt-log.js <path-to-babyai.log> [path-to-private-key.pem]');
  process.exit(1);
}
if (!fs.existsSync(keyPath)) {
  console.error(`Private key not found at ${keyPath}`);
  process.exit(1);
}

const privateKey = fs.readFileSync(keyPath, 'utf8');

const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
for (const line of lines) {
  const parts = line.split(':');
  if (parts.length !== 4) {
    // Not a line in the current encrypted format — print as-is.
    console.log(line);
    continue;
  }
  const [encAesKeyB64, ivB64, tagB64, ctB64] = parts;
  try {
    const aesKey = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
      Buffer.from(encAesKeyB64, 'base64'),
    );
    const iv  = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct  = Buffer.from(ctB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    console.log(pt.toString('utf8'));
  } catch (e) {
    console.log(`[decrypt failed — wrong key or corrupted line] ${line}`);
  }
}

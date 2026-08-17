#!/usr/bin/env node
// Generates an RSA key pair + self-signed X.509 certificate for Salesforce JWT auth.
// Zero external dependencies — uses only Node.js built-in crypto module.
// Usage: node scripts/ci/generate-jwt-keypair.js [commonName]
//
// Output files (written to current working directory):
//   server.key  — paste full content as GitHub secret value (e.g. DEV_JWT_PRIVATE_KEY)
//   server.crt  — upload to Salesforce Connected App "Certificate" field

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CN = process.argv[2] || 'salesforce-ci';

// ── ASN.1 / DER primitives ────────────────────────────────────────────────────

function lenEncode(n) {
  if (n < 0x80) return Buffer.from([n]);
  const tmp = [];
  let v = n;
  while (v > 0) { tmp.unshift(v & 0xff); v >>>= 8; }
  return Buffer.concat([Buffer.from([0x80 | tmp.length]), Buffer.from(tmp)]);
}

function tlv(tag, val) {
  const v = Buffer.isBuffer(val) ? val : Buffer.from(val);
  return Buffer.concat([Buffer.from([tag]), lenEncode(v.length), v]);
}

const SEQ = (v) => tlv(0x30, v);
const SET = (v) => tlv(0x31, v);
const CTX0 = (v) => tlv(0xa0, v);

function INT(val) {
  if (typeof val === 'number') {
    const bs = [];
    let v = val;
    do { bs.unshift(v & 0xff); v >>>= 8; } while (v > 0);
    if (bs[0] & 0x80) bs.unshift(0);
    return tlv(0x02, Buffer.from(bs));
  }
  // Buffer: ensure positive
  const b = Buffer.isBuffer(val) ? val : Buffer.from(val);
  const out = b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b;
  return tlv(0x02, out);
}

function OID(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const seg = [v & 0x7f];
    v >>>= 7;
    while (v > 0) { seg.unshift((v & 0x7f) | 0x80); v >>>= 7; }
    bytes.push(...seg);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const NULL = tlv(0x05, Buffer.alloc(0));
const UTF8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const BITSTR = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));

function UTC(d) {
  const p = (n) => String(n).padStart(2, '0');
  const s = `${String(d.getUTCFullYear()).slice(-2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

function rdnName(cn) {
  return SEQ(SET(SEQ(Buffer.concat([OID('2.5.4.3'), UTF8(cn)]))));
}

// sha256WithRSAEncryption AlgorithmIdentifier
const SHA256_WITH_RSA = SEQ(Buffer.concat([OID('1.2.840.113549.1.1.11'), NULL]));

// ── Key pair generation ───────────────────────────────────────────────────────

const { privateKey: privPem, publicKey: pubPem } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding:  { type: 'pkcs8', format: 'pem' },
});

// Decode SPKI DER from PEM (already a proper SubjectPublicKeyInfo SEQUENCE)
const spkiDer = Buffer.from(
  pubPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
  'base64'
);

// ── Build TBSCertificate ──────────────────────────────────────────────────────

const serial = crypto.randomBytes(16);
serial[0] &= 0x7f; // ensure positive

const now = new Date();
const exp = new Date(now);
exp.setUTCFullYear(exp.getUTCFullYear() + 10);

const tbs = SEQ(Buffer.concat([
  CTX0(INT(2)),               // version: v3
  INT(serial),                // serialNumber
  SHA256_WITH_RSA,            // signature
  rdnName(CN),                // issuer
  SEQ(Buffer.concat([UTC(now), UTC(exp)])), // validity
  rdnName(CN),                // subject
  spkiDer,                    // subjectPublicKeyInfo
]));

// ── Sign & assemble Certificate ───────────────────────────────────────────────

const sig = crypto.createSign('SHA256').update(tbs).sign(privPem);

const certDer = SEQ(Buffer.concat([tbs, SHA256_WITH_RSA, BITSTR(sig)]));

// ── Encode as PEM ─────────────────────────────────────────────────────────────

function toPem(label, der) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

const certPem = toPem('CERTIFICATE', certDer);

// ── Write files ───────────────────────────────────────────────────────────────

const keyPath  = path.join(process.cwd(), 'server.key');
const certPath = path.join(process.cwd(), 'server.crt');

fs.writeFileSync(keyPath, privPem, 'utf8');
fs.writeFileSync(certPath, certPem, 'utf8');

console.log('');
console.log('Files written:');
console.log(`  ${keyPath}`);
console.log(`  ${certPath}`);
console.log('');
console.log('Next steps:');
console.log('  1. server.crt  → upload to Salesforce Connected App (Certificate field)');
console.log('  2. server.key  → paste full file content as GitHub secret e.g. DEV_JWT_PRIVATE_KEY');
console.log('');
console.log('WARNING: Do not commit server.key to Git. Delete both files after storing.');

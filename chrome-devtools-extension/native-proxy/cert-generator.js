'use strict';

const forge = require('node-forge');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CA_DIR = path.join(os.homedir(), '.devtools-pp');
const CA_CERT_PATH = path.join(CA_DIR, 'ca.pem');
const CA_KEY_PATH = path.join(CA_DIR, 'ca-key.pem');

// In-memory cache for host certificates (LRU-like, max 500)
const hostCertCache = new Map();
const MAX_CACHE_SIZE = 500;

let cachedCA = null;

/**
 * Ensure CA certificate exists. Creates one if not found.
 * Returns { cert, key } as PEM strings and { certPath, keyPath } paths.
 */
function ensureCA() {
  if (cachedCA) return cachedCA;

  if (fs.existsSync(CA_CERT_PATH) && fs.existsSync(CA_KEY_PATH)) {
    const certPem = fs.readFileSync(CA_CERT_PATH, 'utf8');
    const keyPem = fs.readFileSync(CA_KEY_PATH, 'utf8');
    cachedCA = {
      cert: forge.pki.certificateFromPem(certPem),
      key: forge.pki.privateKeyFromPem(keyPem),
      certPem,
      keyPem,
      certPath: CA_CERT_PATH,
      keyPath: CA_KEY_PATH,
    };
    return cachedCA;
  }

  // Generate new CA
  if (!fs.existsSync(CA_DIR)) {
    fs.mkdirSync(CA_DIR, { recursive: true });
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: 'DevTools++ MITM CA' },
    { name: 'organizationName', value: 'DevTools++' },
    { name: 'countryName', value: 'KR' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    {
      name: 'subjectKeyIdentifier',
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  fs.writeFileSync(CA_CERT_PATH, certPem);
  fs.writeFileSync(CA_KEY_PATH, keyPem, { mode: 0o600 });

  cachedCA = {
    cert,
    key: keys.privateKey,
    certPem,
    keyPem,
    certPath: CA_CERT_PATH,
    keyPath: CA_KEY_PATH,
  };

  return cachedCA;
}

/**
 * Generate a TLS certificate for a specific hostname, signed by the CA.
 * Results are cached in memory.
 * Returns { cert: PEM, key: PEM }
 */
function generateHostCert(hostname) {
  if (hostCertCache.has(hostname)) {
    return hostCertCache.get(hostname);
  }

  const ca = ensureCA();
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  cert.setSubject([{ name: 'commonName', value: hostname }]);
  cert.setIssuer(ca.cert.subject.attributes);

  // Determine if hostname is an IP address
  const isIP = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
  const altNames = isIP
    ? [{ type: 7, ip: hostname }]
    : [{ type: 2, value: hostname }];

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);

  cert.sign(ca.key, forge.md.sha256.create());

  const result = {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };

  // LRU eviction
  if (hostCertCache.size >= MAX_CACHE_SIZE) {
    const firstKey = hostCertCache.keys().next().value;
    hostCertCache.delete(firstKey);
  }
  hostCertCache.set(hostname, result);

  return result;
}

/**
 * Get CA cert PEM for trust instructions
 */
function getCACertPath() {
  ensureCA();
  return CA_CERT_PATH;
}

module.exports = { ensureCA, generateHostCert, getCACertPath };

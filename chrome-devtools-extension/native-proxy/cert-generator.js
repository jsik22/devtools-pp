'use strict';

const forge = require('node-forge');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

// X.509-compliant 양수 serial number 생성 (16 random bytes, high bit
// 클리어 → 정수가 명확히 양수).
function randomSerial() {
  const bytes = forge.random.getBytesSync(16);
  // 첫 byte의 high bit 클리어 → signed ASN.1 INTEGER로 해석할 때
  // 정수가 양수로 유지되도록.
  const firstByte = bytes.charCodeAt(0) & 0x7f;
  return forge.util.bytesToHex(String.fromCharCode(firstByte) + bytes.slice(1));
}

const CA_DIR = path.join(os.homedir(), '.devtools-pp');
const CA_CERT_PATH = path.join(CA_DIR, 'ca.pem');
const CA_KEY_PATH = path.join(CA_DIR, 'ca-key.pem');

// host 인증서 인메모리 캐시 (LRU 유사, 최대 500)
const hostCertCache = new Map();
const MAX_CACHE_SIZE = 500;

let cachedCA = null;

/**
 * CA 인증서 존재 보장. 없으면 생성.
 * { cert, key }를 PEM 문자열로, { certPath, keyPath }를 경로로 반환.
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

  // 새 CA 생성. mode 0o700으로 다른 로컬 사용자가 디렉토리 목록을 못
  // 보게 함; private key 파일 자체도 0o600으로 기록.
  if (!fs.existsSync(CA_DIR)) {
    fs.mkdirSync(CA_DIR, { recursive: true, mode: 0o700 });
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
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
 * 특정 hostname용 TLS 인증서 생성, CA로 서명. 결과는 인메모리 캐시.
 * { cert: PEM, key: PEM } 반환.
 */
function generateHostCert(hostname) {
  if (hostCertCache.has(hostname)) {
    return hostCertCache.get(hostname);
  }

  const ca = ensureCA();
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  cert.setSubject([{ name: 'commonName', value: hostname }]);
  cert.setIssuer(ca.cert.subject.attributes);

  // net.isIP은 4, 6, 또는 0 반환; non-zero면 IP 주소. out-of-range
  // octet을 수용하고 ":"가 들어간 모든 hostname을 IPv6로 처리하던
  // 느슨한 regex를 대체.
  const ipFamily = net.isIP(hostname);
  const altNames = ipFamily
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

  // LRU 축출
  if (hostCertCache.size >= MAX_CACHE_SIZE) {
    const firstKey = hostCertCache.keys().next().value;
    hostCertCache.delete(firstKey);
  }
  hostCertCache.set(hostname, result);

  return result;
}

/**
 * trust 안내용 CA cert PEM 가져오기
 */
function getCACertPath() {
  ensureCA();
  return CA_CERT_PATH;
}

module.exports = { ensureCA, generateHostCert, getCACertPath };

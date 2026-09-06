import { MASTER_V45 } from './contracts.js';
import chunk01 from '../master-v45/chunk-01.js';
import chunk02 from '../master-v45/chunk-02.js';
import chunk03 from '../master-v45/chunk-03.js';
import chunk04 from '../master-v45/chunk-04.js';
import chunk05 from '../master-v45/chunk-05.js';
import chunk06 from '../master-v45/chunk-06.js';
import chunk07 from '../master-v45/chunk-07.js';
import chunk08 from '../master-v45/chunk-08.js';
import chunk09 from '../master-v45/chunk-09.js';
import chunk10 from '../master-v45/chunk-10.js';
import chunk11 from '../master-v45/chunk-11.js';
import chunk12 from '../master-v45/chunk-12.js';
import chunk13 from '../master-v45/chunk-13.js';
import chunk14 from '../master-v45/chunk-14.js';
import chunk15 from '../master-v45/chunk-15.js';
import chunk16 from '../master-v45/chunk-16.js';
import chunk17 from '../master-v45/chunk-17.js';
import chunk18 from '../master-v45/chunk-18.js';
import chunk19 from '../master-v45/chunk-19.js';
import chunk20 from '../master-v45/chunk-20.js';

const MASTER_V45_GZIP_BASE64 = [
  chunk01, chunk02, chunk03, chunk04, chunk05,
  chunk06, chunk07, chunk08, chunk09, chunk10,
  chunk11, chunk12, chunk13, chunk14, chunk15,
  chunk16, chunk17, chunk18, chunk19, chunk20
].join('');

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

let cachedMaster = null;

export async function loadMasterV45() {
  if (cachedMaster) return cachedMaster;

  const bytes = await gunzip(base64ToBytes(MASTER_V45_GZIP_BASE64));
  if (bytes.byteLength !== MASTER_V45.size) {
    throw Object.assign(new Error('MASTER_V45_SIZE_MISMATCH'), { status: 500, meta: MASTER_V45 });
  }

  const digest = await sha256Hex(bytes);
  if (digest !== MASTER_V45.sha256) {
    throw Object.assign(new Error('MASTER_V45_SHA256_MISMATCH'), { status: 500, meta: MASTER_V45 });
  }

  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  cachedMaster = text;
  return text;
}

export async function masterV45RuntimeStatus() {
  await loadMasterV45();
  return { bundled: true, sha256: MASTER_V45.sha256, size: MASTER_V45.size };
}

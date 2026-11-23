// Bounded, dependency-free ZIP reader/writer for HarbuMatic portable (.hbn) packages.
//
// Writes standard PKZIP (STORE, UTF-8 filenames, IEEE CRC-32, deterministic timestamps).
// Reads STORE (method 0) and bounded DEFLATE (method 8 via DecompressionStream('deflate-raw') when available),
// rejecting corrupt archives, CRC mismatches, ZIP64, multi-disk, encryption, data descriptors, symlinks,
// duplicate or unsafe paths, overlapping local entries and oversized payloads.

const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOC = 0x07064b50;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESC = 0x0008;
const FLAG_PATCHED = 0x0020;
const FLAG_STRONG_ENC = 0x0040;
const FLAG_UTF8 = 0x0800;
const FLAG_MASKED = 0x2000;
const UNSUPPORTED_FLAGS = FLAG_ENCRYPTED | FLAG_DATA_DESC | FLAG_PATCHED | FLAG_STRONG_ENC | FLAG_MASKED;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const DOS_DATE_1980 = 0x0021; // 1980-01-01 (valid DOS date, deterministic output)
const MAX_ZIP32 = 0xfffffffe;

const ENC = new TextEncoder();
const DEC_UTF8 = new TextDecoder('utf-8', { fatal: true });

export const ZIP_DEFAULTS = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxUncompressedBytes: 128 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  maxEntries: 64,
});

export class ZipError extends Error {
  /** code: invalid | corrupt | unsupported | duplicate | too-large | too-many-entries */
  constructor(code, message, cause) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
    this.cause = cause;
  }
}

/* ---------- CRC-32 (IEEE 802.3) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(input) {
  const bytes = toUint8(input);
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function toUint8(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new ZipError('invalid', 'Expected binary data.');
}

/** True when bytes start with a ZIP local header (PK\x03\x04) or empty archive EOCD (PK\x05\x06). */
export function isZipBytes(input) {
  if (!input) return false;
  let b;
  try { b = toUint8(input); } catch (e) { return false; }
  if (b.byteLength < 4) return false;
  return b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 0x03 && b[3] === 0x04) || (b[2] === 0x05 && b[3] === 0x06));
}

function isSafePath(name) {
  if (typeof name !== 'string' || !name.length || name.length > 512) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.includes('\\') || name.includes(':')) return false;
  if (/[\x00-\x1f\x7f]/.test(name)) return false;
  const parts = name.split('/');
  return parts.every(p => p.length > 0 && p !== '.' && p !== '..');
}

/* ---------- Writer (STORE) ---------- */
/**
 * Build a ZIP archive (method 0 / STORE) from `[{ name, data }]`.
 * Rejects invalid paths, duplicate names, and sizes exceeding ZIP32 bounds.
 */
export function createZip(entries) {
  if (!Array.isArray(entries)) throw new ZipError('invalid', 'ZIP entries must be an array.');
  if (entries.length >= 0xffff) throw new ZipError('too-many-entries', 'Too many entries for ZIP32.');

  const prepared = [];
  const seen = new Set();
  let localTotal = 0;
  let cdTotal = 0;

  for (const item of entries) {
    if (!item || typeof item.name !== 'string') throw new ZipError('invalid', 'Invalid ZIP entry.');
    if (!isSafePath(item.name)) throw new ZipError('invalid', `Unsafe ZIP entry path: “${item.name}”.`);
    if (seen.has(item.name)) throw new ZipError('duplicate', `Duplicate ZIP entry: “${item.name}”.`);
    seen.add(item.name);

    const nameBytes = ENC.encode(item.name);
    if (nameBytes.length > 0xffff) throw new ZipError('invalid', `Entry name too long: “${item.name}”.`);
    const data = toUint8(item.data);
    if (data.byteLength > MAX_ZIP32) throw new ZipError('too-large', `Entry too large for ZIP32: “${item.name}”.`);

    const offset = localTotal;
    if (offset > MAX_ZIP32) throw new ZipError('too-large', 'Archive exceeds ZIP32 offset limit.');
    localTotal += 30 + nameBytes.length + data.byteLength;
    cdTotal += 46 + nameBytes.length;
    prepared.push({ nameBytes, data, crc: crc32(data), offset });
  }

  const totalSize = localTotal + cdTotal + 22;
  if (localTotal > MAX_ZIP32 || cdTotal > MAX_ZIP32) throw new ZipError('too-large', 'Archive exceeds ZIP32 size limit.');

  const out = new Uint8Array(totalSize);
  const dv = new DataView(out.buffer);
  let pos = 0;

  for (const e of prepared) {
    dv.setUint32(pos, SIG_LOCAL, true);
    dv.setUint16(pos + 4, 20, true);
    dv.setUint16(pos + 6, FLAG_UTF8, true);
    dv.setUint16(pos + 8, METHOD_STORE, true);
    dv.setUint16(pos + 10, 0, true);
    dv.setUint16(pos + 12, DOS_DATE_1980, true);
    dv.setUint32(pos + 14, e.crc, true);
    dv.setUint32(pos + 18, e.data.byteLength, true);
    dv.setUint32(pos + 22, e.data.byteLength, true);
    dv.setUint16(pos + 26, e.nameBytes.length, true);
    dv.setUint16(pos + 28, 0, true);
    pos += 30;
    out.set(e.nameBytes, pos); pos += e.nameBytes.length;
    out.set(e.data, pos); pos += e.data.byteLength;
  }

  const cdOffset = pos;
  for (const e of prepared) {
    dv.setUint32(pos, SIG_CD, true);
    dv.setUint16(pos + 4, 20, true);
    dv.setUint16(pos + 6, 20, true);
    dv.setUint16(pos + 8, FLAG_UTF8, true);
    dv.setUint16(pos + 10, METHOD_STORE, true);
    dv.setUint16(pos + 12, 0, true);
    dv.setUint16(pos + 14, DOS_DATE_1980, true);
    dv.setUint32(pos + 16, e.crc, true);
    dv.setUint32(pos + 20, e.data.byteLength, true);
    dv.setUint32(pos + 24, e.data.byteLength, true);
    dv.setUint16(pos + 28, e.nameBytes.length, true);
    dv.setUint16(pos + 30, 0, true);
    dv.setUint16(pos + 32, 0, true);
    dv.setUint16(pos + 34, 0, true);
    dv.setUint16(pos + 36, 0, true);
    dv.setUint32(pos + 38, 0, true);
    dv.setUint32(pos + 42, e.offset, true);
    pos += 46;
    out.set(e.nameBytes, pos); pos += e.nameBytes.length;
  }

  const cdSize = pos - cdOffset;
  dv.setUint32(pos, SIG_EOCD, true);
  dv.setUint16(pos + 4, 0, true);
  dv.setUint16(pos + 6, 0, true);
  dv.setUint16(pos + 8, prepared.length, true);
  dv.setUint16(pos + 10, prepared.length, true);
  dv.setUint32(pos + 12, cdSize, true);
  dv.setUint32(pos + 16, cdOffset, true);
  dv.setUint16(pos + 20, 0, true);

  return out;
}

/* ---------- Reader (STORE + bounded DEFLATE) ---------- */
async function inflateRawBounded(compressed, expectedSize, maxBytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('unsupported', 'Compressed ZIP entries are not supported in this browser.');
  }
  const limit = Math.min(expectedSize, maxBytes);
  let ds;
  try { ds = new DecompressionStream('deflate-raw'); }
  catch (e) { throw new ZipError('unsupported', 'Compressed ZIP entries are not supported in this browser.', e); }

  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const writePromise = (async () => {
    try { await writer.write(compressed); await writer.close(); }
    catch (e) { /* reader surfaces stream errors or early cancellation */ }
  })();

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new ZipError(total > maxBytes ? 'too-large' : 'corrupt', 'ZIP entry decompressed size exceeds expected bounds.');
      }
      chunks.push(value);
    }
  } catch (e) {
    await writer.abort().catch(() => {});
    if (e instanceof ZipError) throw e;
    throw new ZipError('corrupt', 'ZIP entry could not be decompressed.', e);
  } finally {
    await writePromise;
  }

  if (total !== expectedSize) throw new ZipError('corrupt', 'ZIP entry decompressed size does not match header.');
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

function findEocd(bytes, dv) {
  const minPos = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let p = bytes.byteLength - 22; p >= minPos; p--) {
    if (dv.getUint32(p, true) === SIG_EOCD && p + 22 + dv.getUint16(p + 20, true) === bytes.byteLength) return p;
  }
  return -1;
}

/**
 * Read and strictly validate a ZIP archive. Returns `Map<string, Uint8Array>`.
 */
export async function readZip(input, opts = {}) {
  const lim = { ...ZIP_DEFAULTS, ...opts };
  const bytes = toUint8(input);
  if (bytes.byteLength > lim.maxArchiveBytes) {
    throw new ZipError('too-large', `Archive is too large (${Math.ceil(bytes.byteLength / 1048576)} MB; max ${Math.round(lim.maxArchiveBytes / 1048576)} MB).`);
  }
  if (bytes.byteLength < 22) throw new ZipError('invalid', 'This file is not a valid ZIP archive.');

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdPos = findEocd(bytes, dv);
  if (eocdPos < 0) throw new ZipError('invalid', 'This file is not a valid ZIP archive.');
  if (eocdPos >= 20 && dv.getUint32(eocdPos - 20, true) === SIG_ZIP64_LOC) {
    throw new ZipError('unsupported', 'ZIP64 archives are not supported.');
  }

  const diskNum = dv.getUint16(eocdPos + 4, true);
  const cdDisk = dv.getUint16(eocdPos + 6, true);
  const diskEntries = dv.getUint16(eocdPos + 8, true);
  const totalEntries = dv.getUint16(eocdPos + 10, true);
  const cdSize = dv.getUint32(eocdPos + 12, true);
  const cdOffset = dv.getUint32(eocdPos + 16, true);

  if (diskNum === 0xffff || cdDisk === 0xffff || diskEntries === 0xffff || totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('unsupported', 'ZIP64 archives are not supported.');
  }
  if (diskNum !== 0 || cdDisk !== 0 || diskEntries !== totalEntries) {
    throw new ZipError('unsupported', 'Multi-disk ZIP archives are not supported.');
  }
  if (totalEntries > lim.maxEntries) {
    throw new ZipError('too-many-entries', `Archive has too many entries (${totalEntries}; max ${lim.maxEntries}).`);
  }
  if (cdOffset + cdSize > eocdPos) {
    throw new ZipError('invalid', 'ZIP central directory is truncated or out of bounds.');
  }

  const metas = [];
  const seen = new Set();
  const spans = [];
  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;
  let totalUncompressed = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > cdEnd || dv.getUint32(cursor, true) !== SIG_CD) {
      throw new ZipError('invalid', 'Corrupt ZIP central directory header.');
    }
    const verMadeBy = dv.getUint16(cursor + 4, true);
    const flags = dv.getUint16(cursor + 8, true);
    const method = dv.getUint16(cursor + 10, true);
    const crc = dv.getUint32(cursor + 16, true);
    const compSize = dv.getUint32(cursor + 20, true);
    const uncompSize = dv.getUint32(cursor + 24, true);
    const nameLen = dv.getUint16(cursor + 28, true);
    const extraLen = dv.getUint16(cursor + 30, true);
    const commentLen = dv.getUint16(cursor + 32, true);
    const diskStart = dv.getUint16(cursor + 34, true);
    const extAttr = dv.getUint32(cursor + 38, true);
    const localOffset = dv.getUint32(cursor + 42, true);

    if (cursor + 46 + nameLen + extraLen + commentLen > cdEnd) {
      throw new ZipError('invalid', 'Truncated ZIP central directory entry.');
    }
    if (diskStart !== 0) throw new ZipError('unsupported', 'Multi-disk ZIP archives are not supported.');
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('unsupported', 'ZIP64 archives are not supported.');
    }
    if (flags & UNSUPPORTED_FLAGS) {
      throw new ZipError('unsupported', 'Encrypted or streaming ZIP archives are not supported.');
    }
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new ZipError('unsupported', `Unsupported ZIP compression method (${method}).`);
    }
    if ((verMadeBy >> 8) === 3 && ((extAttr >>> 16) & 0o170000) === 0o120000) {
      throw new ZipError('unsupported', 'Symbolic links inside archives are not supported.');
    }

    const nameSlice = bytes.subarray(cursor + 46, cursor + 46 + nameLen);
    let name;
    try { name = DEC_UTF8.decode(nameSlice); }
    catch (e) { throw new ZipError('invalid', 'ZIP entry name is not valid UTF-8.', e); }
    if (!isSafePath(name)) throw new ZipError('invalid', `Unsafe or invalid ZIP path: “${name}”.`);
    if (seen.has(name)) throw new ZipError('duplicate', `Duplicate entry in archive: “${name}”.`);
    seen.add(name);

    if (method === METHOD_STORE && compSize !== uncompSize) {
      throw new ZipError('corrupt', `Mismatched sizes for stored entry “${name}”.`);
    }
    if (uncompSize > lim.maxEntryBytes) {
      throw new ZipError('too-large', `Archive entry “${name}” is too large.`);
    }
    totalUncompressed += uncompSize;
    if (totalUncompressed > lim.maxUncompressedBytes) {
      throw new ZipError('too-large', 'Archive uncompressed size exceeds the safety limit.');
    }

    // Validate local file header matches central directory header
    if (localOffset + 30 > cdOffset || dv.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw new ZipError('invalid', `Corrupt local header for “${name}”.`);
    }
    const lfFlags = dv.getUint16(localOffset + 6, true);
    const lfMethod = dv.getUint16(localOffset + 8, true);
    const lfCrc = dv.getUint32(localOffset + 14, true);
    const lfCompSize = dv.getUint32(localOffset + 18, true);
    const lfUncompSize = dv.getUint32(localOffset + 22, true);
    const lfNameLen = dv.getUint16(localOffset + 26, true);
    const lfExtraLen = dv.getUint16(localOffset + 28, true);

    if (lfFlags !== flags || lfMethod !== method || lfCrc !== crc || lfCompSize !== compSize || lfUncompSize !== uncompSize || lfNameLen !== nameLen) {
      throw new ZipError('corrupt', `Header mismatch for archive entry “${name}”.`);
    }
    const lfNameStart = localOffset + 30;
    const dataStart = lfNameStart + lfNameLen + lfExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > cdOffset) {
      throw new ZipError('invalid', `Archive entry “${name}” extends past end of data.`);
    }
    for (let k = 0; k < nameLen; k++) {
      if (bytes[lfNameStart + k] !== nameSlice[k]) {
        throw new ZipError('corrupt', `Filename mismatch between headers for “${name}”.`);
      }
    }

    spans.push({ start: localOffset, end: dataEnd });
    metas.push({ name, method, crc, uncompSize, dataStart, dataEnd });
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  if (cursor !== cdEnd) throw new ZipError('invalid', 'ZIP central directory has unexpected trailing data.');

  // Reject overlapping local entries
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) throw new ZipError('corrupt', 'Archive contains overlapping entries.');
  }

  const out = new Map();
  let remaining = lim.maxUncompressedBytes;
  for (const m of metas) {
    const raw = bytes.subarray(m.dataStart, m.dataEnd);
    const data = m.method === METHOD_STORE
      ? bytes.slice(m.dataStart, m.dataEnd)
      : await inflateRawBounded(raw, m.uncompSize, Math.min(lim.maxEntryBytes, remaining));
    remaining -= data.byteLength;
    if (crc32(data) !== m.crc) throw new ZipError('corrupt', `Checksum mismatch for “${m.name}”.`);
    out.set(m.name, data);
  }
  return out;
}

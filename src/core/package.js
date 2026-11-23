// Portable .hbn project packages (v0.6 Phase 5A).
//
// Format (ZIP container, package version 1):
//   manifest.json       { format: 'harbumatic-package', v: 1, app: <APP_VERSION>, samples: [{ id, name, type, size, sha256, path }] }
//   project.json        validated schema v6 project (unchanged shape; samples referenced by SHA-256 id)
//   samples/<id>.<ext>  original audio bytes for each unique referenced sample
//
// Invariants:
// - Export never produces an incomplete portable project: every referenced sample's bytes and metadata must be
//   available and match its SHA-256 content address, or export aborts with PackageError.
// - Import validates the complete archive, manifest, project schema, paths and SHA-256 hashes in memory before
//   mutating any persistent storage.
// - Restoration confirms durable persistence in the sample store before returning. On failure, pre-existing or
//   shared samples are never touched; only samples newly written or queued by the failed import are cleaned up
//   on a best-effort, non-destructive basis.

import { APP_VERSION } from './constants.js';
import { MAX_SLOTS } from './instruments.js';
import { importProject, validateProject, ProjectError } from './project.js';
import { sampleRefsOf } from './samples.js';
import { clone, isObj } from './util.js';
import { createZip, readZip, isZipBytes, ZipError } from './zip.js';
import { sha256Hex } from '../samples/hash.js';
import { SAMPLE_LIMITS, SampleError } from '../samples/store.js';

export const PACKAGE_FORMAT = 'harbumatic-package';
export const PACKAGE_VERSION = 1;
export const PACKAGE_EXTENSION = '.hbn';
export const PACKAGE_MIME = 'application/octet-stream';

export const PACKAGE_LIMITS = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxUncompressedBytes: 128 * 1024 * 1024,
  maxEntries: MAX_SLOTS + 2,
  maxManifestBytes: 256 * 1024,
  maxProjectBytes: 4 * 1024 * 1024,
  maxSampleBytes: SAMPLE_LIMITS.maxBytes,
});

const SHA256_RE = /^[0-9a-f]{64}$/;
const SHA256_ID_RE = /^smp-[0-9a-f]{64}$/;
const SAMPLE_PATH_RE = /^samples\/(smp-[0-9a-f]{64})\.([a-z0-9]{1,8})$/;
const CTRL_RE = /[\x00-\x1f\x7f]/;

const MIME_EXT = Object.freeze({
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
  'audio/opus': 'opus',
});

const ENC = new TextEncoder();
const DEC_UTF8 = new TextDecoder('utf-8', { fatal: true });

export class PackageError extends Error {
  /**
   * code:
   *   invalid-archive | unsupported-archive | too-large | duplicate-entry | unexpected-entry | missing-entry
   *   | invalid-manifest | unsupported-version | invalid-project | missing-sample | hash-mismatch
   *   | storage-error | decode-error
   */
  constructor(code, message, cause) {
    super(message);
    this.name = 'PackageError';
    this.code = code;
    this.cause = cause;
  }
}

export { isZipBytes };

/** Derive a safe lowercase file extension for a sample's original bytes. */
export function extForSample(meta = {}) {
  const baseMime = String(meta.type || '').split(';')[0].trim().toLowerCase();
  if (MIME_EXT[baseMime]) return MIME_EXT[baseMime];
  const m = String(meta.name || '').trim().match(/\.([a-z0-9]{1,8})$/i);
  if (m) return m[1].toLowerCase();
  return 'bin';
}

function toUint8(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new PackageError('invalid-archive', 'That file is not a valid HarbuMatic .hbn package.');
}

function toArrayBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

function mapZipError(e) {
  if (e instanceof PackageError) return e;
  if (!(e instanceof ZipError)) return new PackageError('invalid-archive', 'That file is not a valid HarbuMatic .hbn package.', e);
  if (e.code === 'too-large' || e.code === 'too-many-entries') return new PackageError('too-large', e.message, e);
  if (e.code === 'duplicate') return new PackageError('duplicate-entry', e.message, e);
  if (e.code === 'unsupported') return new PackageError('unsupported-archive', e.message, e);
  return new PackageError('invalid-archive', 'That .hbn file is damaged or not a valid HarbuMatic package.', e);
}

function decodeJsonEntry(bytes, label, code) {
  let text;
  try { text = DEC_UTF8.decode(bytes); }
  catch (e) { throw new PackageError(code, `Package entry “${label}” is not valid UTF-8.`, e); }
  try { return JSON.parse(text); }
  catch (e) { throw new PackageError(code, `Package entry “${label}” is not valid JSON.`, e); }
}

function sampleNameMap(project) {
  const names = new Map();
  for (const s of (project && project.slots) || []) {
    if (s.sample && s.sample.id && !names.has(s.sample.id)) names.set(s.sample.id, s.sample.name || s.sample.id);
  }
  return names;
}

/* ---------------------------------------------------------
   Export (.hbn)
   --------------------------------------------------------- */
/**
 * Build a portable .hbn ZIP package for `project`.
 * Collects all unique sample references, reads bytes and metadata from `sampleStore`, verifies SHA-256 hashes,
 * and constructs the archive. Aborts with PackageError if any required asset is missing, unreadable, or corrupt.
 */
export async function exportPackage(project, { sampleStore = null, appVersion = APP_VERSION, limits = PACKAGE_LIMITS } = {}) {
  const lim = { ...PACKAGE_LIMITS, ...limits };
  let clean;
  try { clean = validateProject(clone(project)); }
  catch (e) { throw new PackageError('invalid-project', e instanceof ProjectError ? e.message : 'Project data is invalid.', e); }

  const refs = sampleRefsOf(clean);
  const refNames = sampleNameMap(clean);
  const manifestSamples = [];
  const sampleEntries = [];

  if (refs.length > 0) {
    if (!sampleStore) {
      throw new PackageError('missing-sample', 'Cannot export portable project: sample storage is unavailable.');
    }
    for (const id of refs) {
      const label = refNames.get(id) || id;
      if (!SHA256_ID_RE.test(id)) {
        throw new PackageError('hash-mismatch', `Cannot export portable project: sample “${label}” has an invalid sample ID.`);
      }
      let meta, rawBytes;
      try {
        [meta, rawBytes] = await Promise.all([sampleStore.getMeta(id), sampleStore.getBytes(id)]);
      } catch (e) {
        const why = e instanceof SampleError && e.code === 'missing'
          ? `sample “${label}” is missing on this device`
          : `sample “${label}” could not be read from storage`;
        throw new PackageError('missing-sample', `Cannot export portable project: ${why}.`, e);
      }
      if (!isObj(meta)) {
        throw new PackageError('missing-sample', `Cannot export portable project: metadata for sample “${label}” is missing.`);
      }
      let data;
      try { data = toUint8(rawBytes); }
      catch (e) { throw new PackageError('missing-sample', `Cannot export portable project: audio data for sample “${label}” is unreadable.`, e); }
      if (!data.byteLength) {
        throw new PackageError('missing-sample', `Cannot export portable project: audio data for sample “${label}” is empty.`);
      }
      if (data.byteLength > lim.maxSampleBytes) {
        throw new PackageError('too-large', `Cannot export portable project: sample “${label}” exceeds the size limit.`);
      }

      const sha256 = await sha256Hex(data);
      if (`smp-${sha256}` !== id) {
        throw new PackageError('hash-mismatch', `Cannot export portable project: sample “${label}” failed integrity verification.`);
      }

      const ext = extForSample(meta);
      const path = `samples/${id}.${ext}`;
      const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim().slice(0, 80) : label;
      const type = typeof meta.type === 'string' ? meta.type.slice(0, 120) : '';

      manifestSamples.push({ id, name, type, size: data.byteLength, sha256, path });
      sampleEntries.push({ name: path, data });
    }
  }

  const manifest = {
    format: PACKAGE_FORMAT,
    v: PACKAGE_VERSION,
    app: String(appVersion),
    samples: manifestSamples,
  };

  const manifestBytes = ENC.encode(JSON.stringify(manifest, null, 1));
  const projectBytes = ENC.encode(JSON.stringify(clean, null, 1));
  if (manifestBytes.byteLength > lim.maxManifestBytes) {
    throw new PackageError('too-large', 'Package manifest exceeds the size limit.');
  }
  if (projectBytes.byteLength > lim.maxProjectBytes) {
    throw new PackageError('too-large', 'Project data exceeds the size limit.');
  }

  let zipBytes;
  try {
    zipBytes = createZip([
      { name: 'manifest.json', data: manifestBytes },
      { name: 'project.json', data: projectBytes },
      ...sampleEntries,
    ]);
  } catch (e) { throw mapZipError(e); }

  if (zipBytes.byteLength > lim.maxArchiveBytes) {
    throw new PackageError('too-large', `Portable project is too large (${Math.ceil(zipBytes.byteLength / 1048576)} MB; max ${Math.round(lim.maxArchiveBytes / 1048576)} MB).`);
  }

  return { bytes: zipBytes, manifest, project: clean, sampleCount: manifestSamples.length };
}

/* ---------------------------------------------------------
   Import validation (pure, side-effect free)
   --------------------------------------------------------- */
function validateManifest(raw, lim) {
  if (!isObj(raw)) throw new PackageError('invalid-manifest', 'Package manifest is malformed.');
  if (raw.format !== PACKAGE_FORMAT) {
    throw new PackageError('invalid-manifest', 'That file is not a HarbuMatic .hbn package.');
  }
  if (!Number.isInteger(raw.v)) {
    throw new PackageError('unsupported-version', 'Package manifest has an invalid version.');
  }
  if (raw.v > PACKAGE_VERSION) {
    throw new PackageError('unsupported-version', `This .hbn package uses format v${raw.v}; this version of HarbuMatic supports v${PACKAGE_VERSION}. Please update the app.`);
  }
  if (raw.v !== PACKAGE_VERSION) {
    throw new PackageError('unsupported-version', `Unsupported .hbn package version (v${raw.v}).`);
  }
  if (typeof raw.app !== 'string' || !raw.app.trim() || raw.app.length > 32 || CTRL_RE.test(raw.app)) {
    throw new PackageError('invalid-manifest', 'Package manifest has an invalid app version.');
  }
  if (!Array.isArray(raw.samples)) {
    throw new PackageError('invalid-manifest', 'Package manifest has an invalid samples list.');
  }
  if (raw.samples.length > MAX_SLOTS) {
    throw new PackageError('invalid-manifest', `Package lists too many samples (${raw.samples.length}; max ${MAX_SLOTS}).`);
  }

  const samples = [];
  const seen = new Set();
  for (const s of raw.samples) {
    if (!isObj(s)) throw new PackageError('invalid-manifest', 'Package manifest contains a malformed sample entry.');
    if (typeof s.id !== 'string' || !SHA256_ID_RE.test(s.id)) {
      throw new PackageError('invalid-manifest', 'Package manifest contains an invalid sample ID.');
    }
    if (seen.has(s.id)) {
      throw new PackageError('duplicate-entry', `Package manifest lists sample “${s.id}” more than once.`);
    }
    seen.add(s.id);
    if (typeof s.sha256 !== 'string' || !SHA256_RE.test(s.sha256) || `smp-${s.sha256}` !== s.id) {
      throw new PackageError('hash-mismatch', `Package manifest hash does not match sample ID “${s.id}”.`);
    }
    if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 200 || CTRL_RE.test(s.name)) {
      throw new PackageError('invalid-manifest', `Package manifest has an invalid name for sample “${s.id}”.`);
    }
    if (typeof s.type !== 'string' || s.type.length > 120 || CTRL_RE.test(s.type)) {
      throw new PackageError('invalid-manifest', `Package manifest has an invalid MIME type for sample “${s.name}”.`);
    }
    if (!Number.isInteger(s.size) || s.size <= 0 || s.size > lim.maxSampleBytes) {
      throw new PackageError('invalid-manifest', `Package manifest has an invalid size for sample “${s.name}”.`);
    }
    let path = null;
    if (s.path !== undefined) {
      if (typeof s.path !== 'string') {
        throw new PackageError('invalid-manifest', `Package manifest has an invalid path for sample “${s.name}”.`);
      }
      const m = s.path.match(SAMPLE_PATH_RE);
      if (!m || m[1] !== s.id) {
        throw new PackageError('invalid-manifest', `Package manifest path does not match sample “${s.name}”.`);
      }
      path = s.path;
    }
    samples.push({
      id: s.id,
      name: s.name.trim().slice(0, 80),
      type: s.type,
      size: s.size,
      sha256: s.sha256,
      path,
    });
  }
  return { format: PACKAGE_FORMAT, v: PACKAGE_VERSION, app: raw.app.trim(), samples };
}

/**
 * Parse and fully validate a .hbn package in memory without touching any persistent storage.
 * Verifies ZIP structure, size bounds, allowed paths, manifest, project schema, references, sizes and SHA-256 hashes.
 */
export async function parsePackage(input, { limits = PACKAGE_LIMITS } = {}) {
  const lim = { ...PACKAGE_LIMITS, ...limits };
  const bytes = toUint8(input);
  if (!bytes.byteLength) throw new PackageError('invalid-archive', 'That .hbn file is empty.');
  if (bytes.byteLength > lim.maxArchiveBytes) {
    throw new PackageError('too-large', `That .hbn file is too large (${Math.ceil(bytes.byteLength / 1048576)} MB; max ${Math.round(lim.maxArchiveBytes / 1048576)} MB).`);
  }

  let entries;
  try {
    entries = await readZip(bytes, {
      maxArchiveBytes: lim.maxArchiveBytes,
      maxUncompressedBytes: lim.maxUncompressedBytes,
      maxEntries: lim.maxEntries,
      maxEntryBytes: lim.maxSampleBytes,
    });
  } catch (e) { throw mapZipError(e); }

  if (!entries.has('manifest.json')) {
    throw new PackageError('missing-entry', 'That .hbn package is missing manifest.json.');
  }
  if (!entries.has('project.json')) {
    throw new PackageError('missing-entry', 'That .hbn package is missing project.json.');
  }

  const manifestBytes = entries.get('manifest.json');
  const projectBytes = entries.get('project.json');
  if (manifestBytes.byteLength > lim.maxManifestBytes) {
    throw new PackageError('too-large', 'Package manifest.json exceeds the size limit.');
  }
  if (projectBytes.byteLength > lim.maxProjectBytes) {
    throw new PackageError('too-large', 'Package project.json exceeds the size limit.');
  }

  const rawManifest = decodeJsonEntry(manifestBytes, 'manifest.json', 'invalid-manifest');
  const manifest = validateManifest(rawManifest, lim);

  // Enforce strict path allowlist across all archive entries
  const sampleFiles = new Map();
  for (const [name, data] of entries) {
    if (name === 'manifest.json' || name === 'project.json') continue;
    const m = name.match(SAMPLE_PATH_RE);
    if (!m) throw new PackageError('unexpected-entry', `Package contains an unexpected file: “${name}”.`);
    const id = m[1];
    if (sampleFiles.has(id)) {
      throw new PackageError('duplicate-entry', `Package contains duplicate audio files for sample “${id}”.`);
    }
    sampleFiles.set(id, { path: name, data });
  }

  // Validate project.json through existing schema handling
  const rawProject = decodeJsonEntry(projectBytes, 'project.json', 'invalid-project');
  let project;
  try { project = importProject(rawProject); }
  catch (e) {
    throw new PackageError('invalid-project', e instanceof ProjectError ? e.message : 'Package contains invalid project data.', e);
  }

  // Cross-validate project sample references, manifest entries and ZIP sample files
  const projectRefs = sampleRefsOf(project);
  const projectRefSet = new Set(projectRefs);
  const manifestById = new Map(manifest.samples.map(s => [s.id, s]));

  for (const id of projectRefs) {
    if (!manifestById.has(id)) {
      throw new PackageError('missing-entry', `Package manifest is missing referenced sample “${id}”.`);
    }
    if (!sampleFiles.has(id)) {
      throw new PackageError('missing-entry', `Package is missing audio file for sample “${manifestById.get(id).name}”.`);
    }
  }
  for (const s of manifest.samples) {
    if (!projectRefSet.has(s.id)) {
      throw new PackageError('unexpected-entry', `Package manifest lists unreferenced sample “${s.name}”.`);
    }
    const f = sampleFiles.get(s.id);
    if (!f) {
      throw new PackageError('missing-entry', `Package is missing audio file for sample “${s.name}”.`);
    }
    if (s.path && f.path !== s.path) {
      throw new PackageError('invalid-manifest', `Package file path mismatch for sample “${s.name}”.`);
    }
  }
  for (const [id, f] of sampleFiles) {
    if (!manifestById.has(id)) {
      throw new PackageError('unexpected-entry', `Package contains an unreferenced audio file: “${f.path}”.`);
    }
  }

  // Verify sizes and SHA-256 hashes of all embedded audio assets
  const validatedSamples = [];
  for (const s of manifest.samples) {
    const f = sampleFiles.get(s.id);
    if (!f.data.byteLength || f.data.byteLength !== s.size) {
      throw new PackageError('invalid-manifest', `Audio size for “${s.name}” does not match the package manifest.`);
    }
    if (f.data.byteLength > lim.maxSampleBytes) {
      throw new PackageError('too-large', `Audio file “${s.name}” exceeds the sample size limit.`);
    }
    const actualSha = await sha256Hex(f.data);
    if (actualSha !== s.sha256 || `smp-${actualSha}` !== s.id) {
      throw new PackageError('hash-mismatch', `Audio file “${s.name}” failed integrity verification (hash mismatch).`);
    }
    validatedSamples.push({
      id: s.id,
      name: s.name,
      type: s.type,
      size: s.size,
      sha256: s.sha256,
      path: f.path,
      bytes: toArrayBuffer(f.data),
    });
  }

  return { manifest, project, samples: validatedSamples };
}

/* ---------------------------------------------------------
   Sample restoration + persistence confirmation
   --------------------------------------------------------- */
/**
 * Restore validated package samples into `sampleStore` and confirm durable persistence.
 *
 * Non-destructive cleanup policy:
 * - Before writing, snapshots which sample IDs are already persisted (`has`) or already unsaved (`isUnsaved`),
 *   and merges them with `referenced` (sample IDs used by existing library songs) into `protectedIds`.
 * - If any sample fails decoding, fails writing, or fails the post-write `has(id)` persistence check, only
 *   samples newly introduced by this failed import (not in `protectedIds`) are removed via best-effort
 *   `sampleStore.remove(id, { referenced: protectedIds })`. Pre-existing or shared assets are never deleted.
 * - Returns `{ project, manifest, restored, reused, cleanup }` so callers can also run `cleanup()` if saving
 *   the project metadata itself fails before adoption.
 */
export async function restorePackage(parsed, { sampleStore = null, decode = undefined, referenced = new Set() } = {}) {
  const { project, manifest, samples } = parsed;
  if (!samples.length) {
    return { project, manifest, restored: [], reused: [], cleanup: async () => {} };
  }
  if (!sampleStore) {
    throw new PackageError('storage-error', 'Sample storage is unavailable on this device.');
  }

  const preStored = new Set();
  const preUnsaved = new Set();
  for (const s of samples) {
    if (await sampleStore.has(s.id)) preStored.add(s.id);
    if (sampleStore.isUnsaved && sampleStore.isUnsaved(s.id)) preUnsaved.add(s.id);
  }

  const protectedIds = new Set([...referenced, ...preStored, ...preUnsaved]);
  const newlyAdded = [];
  const restored = [];
  const reused = [];

  const cleanup = async () => {
    for (const id of newlyAdded) {
      if (protectedIds.has(id)) continue;
      try { await sampleStore.remove(id, { referenced: protectedIds }); }
      catch (e) { /* best-effort non-destructive cleanup */ }
    }
  };

  try {
    for (const s of samples) {
      const payload = { bytes: s.bytes.slice(0), name: s.name, type: s.type };
      let res;
      try {
        res = decode !== undefined ? await sampleStore.importBytes(payload, decode) : await sampleStore.importBytes(payload);
      } catch (e) {
        if (e instanceof SampleError) {
          const code = ['unsupported', 'too-long', 'empty', 'too-large', 'not-ready'].includes(e.code)
            ? 'decode-error' : 'storage-error';
          throw new PackageError(code, `Could not import sample “${s.name}”: ${e.message}`, e);
        }
        throw new PackageError('storage-error', `Could not import sample “${s.name}”.`, e);
      }

      if (!protectedIds.has(s.id)) newlyAdded.push(s.id);

      if (!res || !res.meta || res.meta.id !== s.id) {
        throw new PackageError('hash-mismatch', `Sample “${s.name}” failed integrity check during import.`);
      }
      if (!res.stored) {
        const reason = res.error ? res.error.message : 'Sample could not be saved to browser storage.';
        throw new PackageError('storage-error', `Could not save sample “${s.name}”: ${reason}`, res.error);
      }
      const persisted = await sampleStore.has(s.id);
      if (!persisted) {
        throw new PackageError('storage-error', `Could not confirm storage persistence for sample “${s.name}”.`);
      }

      if (res.duplicate || preStored.has(s.id)) reused.push(s.id);
      else restored.push(s.id);
    }
  } catch (err) {
    await cleanup();
    throw err;
  }

  return { project, manifest, restored, reused, cleanup };
}

/** Validate a .hbn package in full and restore its samples into `sampleStore`. */
export async function importPackage(input, { sampleStore = null, decode = undefined, referenced = new Set(), limits = PACKAGE_LIMITS } = {}) {
  const parsed = await parsePackage(input, { limits });
  return restorePackage(parsed, { sampleStore, decode, referenced });
}

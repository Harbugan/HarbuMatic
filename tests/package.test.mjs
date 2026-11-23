// Portable .hbn project packages (v0.6 Phase 5A):
// ZIP adapter bounds/safety, package format v1, MUNCH audio roundtrips, missing/unsaved assets,
// corrupt/invalid/oversized archives, manifest/version/hash mismatches, storage write failures with
// non-destructive cleanup, legacy JSON and v4/v5 compatibility, existing project preservation,
// and repeated imports without destructive sample duplication.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createZip, readZip, crc32, isZipBytes, ZipError } from '../src/core/zip.js';
import {
  exportPackage, parsePackage, restorePackage, importPackage, extForSample,
  PackageError, PACKAGE_FORMAT, PACKAGE_VERSION,
} from '../src/core/package.js';
import {
  createEmptyProject, createDemoProject, createSlot, nextSlotId, slotById, importProject,
} from '../src/core/project.js';
import { sampleRefFor, defaultSlices, sampleRefsOf } from '../src/core/samples.js';
import { createLibrary, memoryStorage } from '../src/core/persistence.js';
import { createSampleStore, memoryBackend } from '../src/samples/store.js';
import { sha256Hex } from '../src/samples/hash.js';
import { APP_VERSION } from '../src/core/constants.js';
import * as A from '../src/app/actions.js';
import { store, on } from '../src/app/store.js';
import { makeWav, decodeWav } from './helpers/audio.mjs';

const ENC = new TextEncoder();
const fxText = f => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const newSampleStore = (opts = {}) => {
  const backend = memoryBackend(opts);
  return { backend, sampleStore: createSampleStore({ backend, decode: decodeWav }) };
};
const pkgCode = c => e => e instanceof PackageError && e.code === c;
const zipCode = c => e => e instanceof ZipError && e.code === c;

function fakeFile(name, data, { type = '', size } = {}) {
  const u8 = typeof data === 'string' ? ENC.encode(data) : new Uint8Array(data);
  return {
    name,
    type,
    size: size ?? u8.byteLength,
    async arrayBuffer() { return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); },
    async text() { return new TextDecoder('utf-8', { fatal: true }).decode(u8); },
  };
}

/** Build a custom ZIP with raw control over flags/method/duplicate names for negative tests. */
function makeRawZip(entries, { eocdPatch, cdPatch, localPatch } = {}) {
  const recs = [];
  let localTotal = 0, cdTotal = 0;
  for (const e of entries) {
    const nameBytes = ENC.encode(e.name);
    const data = e.data instanceof Uint8Array ? e.data : ENC.encode(String(e.data));
    const offset = localTotal;
    localTotal += 30 + nameBytes.length + data.byteLength;
    cdTotal += 46 + nameBytes.length;
    recs.push({ ...e, nameBytes, data, crc: e.crc ?? crc32(data), offset });
  }
  const out = new Uint8Array(localTotal + cdTotal + 22);
  const dv = new DataView(out.buffer);
  let pos = 0;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const start = pos;
    dv.setUint32(pos, 0x04034b50, true);
    dv.setUint16(pos + 4, 20, true);
    dv.setUint16(pos + 6, r.flags ?? 0x0800, true);
    dv.setUint16(pos + 8, r.method ?? 0, true);
    dv.setUint16(pos + 10, 0, true);
    dv.setUint16(pos + 12, 0x0021, true);
    dv.setUint32(pos + 14, r.crc, true);
    dv.setUint32(pos + 18, r.compSize ?? r.data.byteLength, true);
    dv.setUint32(pos + 22, r.uncompSize ?? r.data.byteLength, true);
    dv.setUint16(pos + 26, r.nameBytes.length, true);
    dv.setUint16(pos + 28, 0, true);
    pos += 30;
    out.set(r.nameBytes, pos); pos += r.nameBytes.length;
    out.set(r.data, pos); pos += r.data.byteLength;
    if (localPatch) localPatch(dv, start, i, r);
  }
  const cdOffset = pos;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const start = pos;
    dv.setUint32(pos, 0x02014b50, true);
    dv.setUint16(pos + 4, r.verMadeBy ?? 20, true);
    dv.setUint16(pos + 6, 20, true);
    dv.setUint16(pos + 8, r.flags ?? 0x0800, true);
    dv.setUint16(pos + 10, r.method ?? 0, true);
    dv.setUint16(pos + 12, 0, true);
    dv.setUint16(pos + 14, 0x0021, true);
    dv.setUint32(pos + 16, r.crc, true);
    dv.setUint32(pos + 20, r.compSize ?? r.data.byteLength, true);
    dv.setUint32(pos + 24, r.uncompSize ?? r.data.byteLength, true);
    dv.setUint16(pos + 28, r.nameBytes.length, true);
    dv.setUint16(pos + 30, 0, true);
    dv.setUint16(pos + 32, 0, true);
    dv.setUint16(pos + 34, r.diskStart ?? 0, true);
    dv.setUint16(pos + 36, 0, true);
    dv.setUint32(pos + 38, r.extAttr ?? 0, true);
    dv.setUint32(pos + 42, r.localOffset ?? r.offset, true);
    pos += 46;
    out.set(r.nameBytes, pos); pos += r.nameBytes.length;
    if (cdPatch) cdPatch(dv, start, i, r);
  }
  const cdSize = pos - cdOffset;
  const eocdPos = pos;
  dv.setUint32(pos, 0x06054b50, true);
  dv.setUint16(pos + 4, 0, true);
  dv.setUint16(pos + 6, 0, true);
  dv.setUint16(pos + 8, recs.length, true);
  dv.setUint16(pos + 10, recs.length, true);
  dv.setUint32(pos + 12, cdSize, true);
  dv.setUint32(pos + 16, cdOffset, true);
  dv.setUint16(pos + 20, 0, true);
  if (eocdPatch) eocdPatch(dv, eocdPos, cdOffset, cdSize);
  return out;
}

async function deflateRaw(u8) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  const wp = (async () => { await writer.write(u8); await writer.close(); })();
  const chunks = [];
  let len = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value); len += value.byteLength;
  }
  await wp;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/* ---------------------------------------------------------
   1. Empty project roundtrip
   --------------------------------------------------------- */
test('empty project roundtrips through .hbn without touching sample storage', async () => {
  const proj = createEmptyProject({ name: 'Blank Canvas', bpm: 124, mood: 'dark' });
  const exported = await exportPackage(proj); // no sampleStore passed: proves sample storage is untouched
  assert.ok(isZipBytes(exported.bytes));
  assert.equal(exported.sampleCount, 0);
  assert.equal(exported.manifest.format, PACKAGE_FORMAT);
  assert.equal(exported.manifest.v, PACKAGE_VERSION);
  assert.equal(exported.manifest.app, APP_VERSION);
  assert.deepEqual(exported.manifest.samples, []);

  const entries = await readZip(exported.bytes);
  assert.deepEqual([...entries.keys()], ['manifest.json', 'project.json']);

  const imported = await importPackage(exported.bytes);
  assert.deepEqual(imported.project, exported.project);
  assert.equal(imported.project.v, 6);
  assert.equal(imported.project.name, 'Blank Canvas');
  assert.equal(imported.project.bpm, 124);
  assert.deepEqual(imported.restored, []);
  assert.deepEqual(imported.reused, []);
});

/* ---------------------------------------------------------
   2. MUNCH project roundtrip with original audio bytes (including DEFLATE read)
   --------------------------------------------------------- */
test('MUNCH project roundtrips to a fresh store with byte-identical audio and slices', async () => {
  const src = newSampleStore();
  const dst = newSampleStore();
  const wav = makeWav({ seconds: 0.75, rate: 44100, channels: 2, freq: 330 });
  const { meta } = await src.sampleStore.importBytes({ bytes: wav, name: 'break-loop.wav', type: 'audio/wav' });

  const proj = createDemoProject();
  proj.name = 'Munch Jam';
  const munch = slotById(proj, 'slot-05');
  munch.sample = sampleRefFor(meta, [0, 0.15, 0.4, 0.75, 1]);
  munch.params.fit = '2';
  munch.params.reverse = true;
  munch.patterns['scene-01'].notes.push({ s: 0, p: 60, l: 2, v: 0.9, slice: 1 });

  const exported = await exportPackage(proj, { sampleStore: src.sampleStore });
  assert.equal(exported.sampleCount, 1);
  assert.equal(exported.manifest.samples[0].id, meta.id);
  assert.equal(exported.manifest.samples[0].name, 'break-loop.wav');
  assert.equal(exported.manifest.samples[0].type, 'audio/wav');
  assert.equal(exported.manifest.samples[0].size, wav.byteLength);
  assert.equal(exported.manifest.samples[0].path, `samples/${meta.id}.wav`);

  const imported = await importPackage(exported.bytes, { sampleStore: dst.sampleStore });
  assert.deepEqual(imported.restored, [meta.id]);
  assert.deepEqual(imported.reused, []);
  assert.ok(await dst.sampleStore.has(meta.id), 'sample persisted in destination store');

  const restoredBytes = await dst.sampleStore.getBytes(meta.id);
  assert.deepEqual(new Uint8Array(restoredBytes), new Uint8Array(wav), 'original audio bytes preserved identically');
  const restoredMeta = await dst.sampleStore.getMeta(meta.id);
  assert.equal(restoredMeta.name, 'break-loop.wav');
  assert.equal(restoredMeta.type, 'audio/wav');
  assert.deepEqual(slotById(imported.project, 'slot-05').sample, munch.sample);
  assert.equal(slotById(imported.project, 'slot-05').params.fit, '2');
  assert.equal(slotById(imported.project, 'slot-05').params.reverse, true);

  // Also verify DEFLATE-compressed archives (e.g. repacked by external ZIP tools) import cleanly
  const zipEntries = await readZip(exported.bytes);
  const deflatedRecs = [];
  for (const [name, data] of zipEntries) {
    const comp = await deflateRaw(data);
    deflatedRecs.push({ name, data: comp, method: 8, crc: crc32(data), compSize: comp.byteLength, uncompSize: data.byteLength });
  }
  const deflatedArchive = makeRawZip(deflatedRecs);
  const dst2 = newSampleStore();
  const fromDeflate = await importPackage(deflatedArchive, { sampleStore: dst2.sampleStore });
  assert.deepEqual(new Uint8Array(await dst2.sampleStore.getBytes(meta.id)), new Uint8Array(wav));
  assert.equal(fromDeflate.project.name, 'Munch Jam');
});

test('extForSample handles MIME parameters, common audio types, filename fallback and bin fallback', () => {
  assert.equal(extForSample({ type: 'audio/webm;codecs=opus', name: 'rec' }), 'webm');
  assert.equal(extForSample({ type: 'audio/mp4; codecs=mp4a.40.2', name: 'rec' }), 'm4a');
  assert.equal(extForSample({ type: 'audio/mpeg', name: 'track' }), 'mp3');
  assert.equal(extForSample({ type: '', name: 'voice.FLAC' }), 'flac');
  assert.equal(extForSample({ type: 'application/octet-stream', name: 'noext' }), 'bin');
});

/* ---------------------------------------------------------
   3. Multiple and duplicate sample references
   --------------------------------------------------------- */
test('multiple distinct samples are all embedded; duplicate references across slots are deduplicated', async () => {
  const src = newSampleStore();
  const wavA = makeWav({ seconds: 0.4, freq: 220 });
  const wavB = makeWav({ seconds: 0.5, freq: 550 });
  const a = (await src.sampleStore.importBytes({ bytes: wavA, name: 'a.wav', type: 'audio/wav' })).meta;
  const b = (await src.sampleStore.importBytes({ bytes: wavB, name: 'b.wav', type: 'audio/wav' })).meta;

  // Two MUNCH slots with two distinct samples
  const projMulti = createEmptyProject({ name: 'Two Samplers' });
  const sceneIds = projMulti.scenes.map(s => s.id);
  const slot6 = createSlot('munch', nextSlotId(projMulti), sceneIds);
  projMulti.slots.push(slot6);
  slotById(projMulti, 'slot-05').sample = sampleRefFor(a);
  slotById(projMulti, slot6.id).sample = sampleRefFor(b);

  const expMulti = await exportPackage(projMulti, { sampleStore: src.sampleStore });
  assert.equal(expMulti.sampleCount, 2);
  assert.deepEqual(expMulti.manifest.samples.map(s => s.id), [a.id, b.id]);
  const dstMulti = newSampleStore();
  const impMulti = await importPackage(expMulti.bytes, { sampleStore: dstMulti.sampleStore });
  assert.deepEqual(impMulti.restored, [a.id, b.id]);
  assert.deepEqual(new Uint8Array(await dstMulti.sampleStore.getBytes(a.id)), new Uint8Array(wavA));
  assert.deepEqual(new Uint8Array(await dstMulti.sampleStore.getBytes(b.id)), new Uint8Array(wavB));

  // Two MUNCH slots pointing at the SAME sample id → stored once in package and destination store
  const projDup = createEmptyProject({ name: 'Shared Sample' });
  const slot6b = createSlot('munch', nextSlotId(projDup), projDup.scenes.map(s => s.id));
  projDup.slots.push(slot6b);
  slotById(projDup, 'slot-05').sample = sampleRefFor(a, defaultSlices(4));
  slotById(projDup, slot6b.id).sample = sampleRefFor(a, defaultSlices(8));

  assert.deepEqual(sampleRefsOf(projDup), [a.id]);
  const expDup = await exportPackage(projDup, { sampleStore: src.sampleStore });
  assert.equal(expDup.sampleCount, 1);
  const zipMap = await readZip(expDup.bytes);
  assert.equal(zipMap.size, 3); // manifest.json, project.json, 1 sample file

  const dstDup = newSampleStore();
  const impDup = await importPackage(expDup.bytes, { sampleStore: dstDup.sampleStore });
  assert.equal(dstDup.backend.db.bytes.size, 1);
  assert.equal(slotById(impDup.project, 'slot-05').sample.slices.length, 5);
  assert.equal(slotById(impDup.project, slot6b.id).sample.slices.length, 9);
});

/* ---------------------------------------------------------
   4. Export with missing or unsaved assets
   --------------------------------------------------------- */
test('export aborts clearly on missing, unreadable or corrupted assets and never falls back to JSON', async () => {
  const { backend, sampleStore } = newSampleStore();
  const wav = makeWav({ seconds: 0.3, freq: 440 });
  const id = `smp-${await sha256Hex(wav)}`;

  const proj = createEmptyProject({ name: 'Broken Export' });
  slotById(proj, 'slot-05').sample = { id, name: 'ghost.wav', duration: 0.3, sampleRate: 44100, channels: 1, slices: defaultSlices(8) };

  // Missing asset
  await assert.rejects(exportPackage(proj, { sampleStore }), e => pkgCode('missing-sample')(e) && /ghost\.wav/.test(e.message));

  // Through actions.js: no download happens, clear toast emitted, returns { ok: false }
  store.project = proj;
  let downloaded = false;
  const toasts = [];
  const off = on('toast', m => toasts.push(m));
  const res = await A.exportProject({ sampleStore, download: () => { downloaded = true; } });
  off();
  assert.equal(res.ok, false);
  assert.equal(downloaded, false, 'must not trigger download or fall back to JSON');
  assert.ok(toasts.some(t => /ghost\.wav/.test(t) && /missing/i.test(t)));

  // Corrupted bytes in store (hash mismatch)
  const { meta } = await sampleStore.importBytes({ bytes: wav, name: 'ghost.wav', type: 'audio/wav' });
  const tampered = new Uint8Array(wav.slice(0));
  tampered[tampered.length - 1] ^= 0xff;
  backend.db.bytes.set(meta.id, { id: meta.id, data: tampered.buffer });
  await assert.rejects(exportPackage(proj, { sampleStore }), pkgCode('hash-mismatch'));

  // Missing metadata (bytes present, meta deleted)
  backend.db.bytes.set(meta.id, { id: meta.id, data: wav.slice(0) });
  backend.db.meta.delete(meta.id);
  await assert.rejects(exportPackage(proj, { sampleStore }), pkgCode('missing-sample'));
});

test('export rescues an unsaved in-memory sample when verified bytes are available in store pending cache', async () => {
  const { sampleStore } = newSampleStore({ quotaBytes: 10 }); // forces stored: false (unsaved in-memory pending)
  const wav = makeWav({ seconds: 0.3, freq: 300 });
  const imp = await sampleStore.importBytes({ bytes: wav, name: 'unsaved.wav', type: 'audio/wav' });
  assert.equal(imp.stored, false);
  assert.equal(sampleStore.isUnsaved(imp.meta.id), true);
  assert.equal(await sampleStore.has(imp.meta.id), false);

  const proj = createEmptyProject({ name: 'Rescue Me' });
  slotById(proj, 'slot-05').sample = sampleRefFor(imp.meta);

  const exported = await exportPackage(proj, { sampleStore });
  assert.equal(exported.sampleCount, 1);

  const dst = newSampleStore();
  const restored = await importPackage(exported.bytes, { sampleStore: dst.sampleStore });
  assert.deepEqual(restored.restored, [imp.meta.id]);
  assert.deepEqual(new Uint8Array(await dst.sampleStore.getBytes(imp.meta.id)), new Uint8Array(wav));
});

/* ---------------------------------------------------------
   5. Invalid ZIP, missing entries, duplicate paths, unexpected paths & oversized archives
   --------------------------------------------------------- */
test('rejects invalid ZIPs, bad CRCs, header mismatches, overlapping entries and unsupported ZIP features', async () => {
  await assert.rejects(parsePackage(new Uint8Array(0)), pkgCode('invalid-archive'));
  await assert.rejects(parsePackage(ENC.encode('not a zip file at all')), pkgCode('invalid-archive'));

  const base = await exportPackage(createEmptyProject());
  // Truncated archive
  await assert.rejects(parsePackage(base.bytes.slice(0, base.bytes.length - 5)), pkgCode('invalid-archive'));

  // Bad CRC-32
  const badCrc = makeRawZip([
    { name: 'manifest.json', data: JSON.stringify({ format: PACKAGE_FORMAT, v: 1, app: APP_VERSION, samples: [] }), crc: 0xdeadbeef },
    { name: 'project.json', data: JSON.stringify(createEmptyProject()) },
  ]);
  await assert.rejects(parsePackage(badCrc), pkgCode('invalid-archive'));

  // Encrypted flag (bit 0)
  const encrypted = makeRawZip([
    { name: 'manifest.json', data: '{}', flags: 0x0801 },
    { name: 'project.json', data: '{}' },
  ]);
  await assert.rejects(parsePackage(encrypted), pkgCode('unsupported-archive'));

  // Data descriptor flag (bit 3)
  const dataDesc = makeRawZip([
    { name: 'manifest.json', data: '{}', flags: 0x0808 },
    { name: 'project.json', data: '{}' },
  ]);
  await assert.rejects(parsePackage(dataDesc), pkgCode('unsupported-archive'));

  // Unsupported compression method (99)
  const badMethod = makeRawZip([
    { name: 'manifest.json', data: '{}', method: 99 },
    { name: 'project.json', data: '{}' },
  ]);
  await assert.rejects(parsePackage(badMethod), pkgCode('unsupported-archive'));

  // Multi-disk archive
  const multiDisk = makeRawZip([{ name: 'manifest.json', data: '{}' }], {
    eocdPatch: (dv, p) => dv.setUint16(p + 4, 1, true),
  });
  await assert.rejects(parsePackage(multiDisk), pkgCode('unsupported-archive'));

  // ZIP64 sentinel
  const zip64 = makeRawZip([{ name: 'manifest.json', data: '{}' }], {
    eocdPatch: (dv, p) => dv.setUint16(p + 10, 0xffff, true),
  });
  await assert.rejects(parsePackage(zip64), pkgCode('unsupported-archive'));

  // Unix symlink entry
  const symlink = makeRawZip([
    { name: 'manifest.json', data: '{}', verMadeBy: (3 << 8) | 20, extAttr: 0o120777 << 16 },
  ]);
  await assert.rejects(parsePackage(symlink), pkgCode('unsupported-archive'));

  // Local header vs CD header mismatch
  const mismatch = makeRawZip([
    { name: 'manifest.json', data: '{}' },
  ], {
    localPatch: (dv, p) => dv.setUint16(p + 6, 0, true),
  });
  await assert.rejects(parsePackage(mismatch), pkgCode('invalid-archive'));

  // Overlapping local entries (both CD records point to offset 0)
  const overlap = makeRawZip([
    { name: 'manifest.json', data: '{}' },
    { name: 'project.json', data: '{}', localOffset: 0 },
  ]);
  await assert.rejects(parsePackage(overlap), pkgCode('invalid-archive'));
});

test('rejects missing entries, unexpected paths, duplicate paths and oversized archives', async () => {
  const proj = createEmptyProject();
  const validManifest = JSON.stringify({ format: PACKAGE_FORMAT, v: 1, app: APP_VERSION, samples: [] });
  const validProject = JSON.stringify(proj);

  // Missing manifest.json
  await assert.rejects(parsePackage(createZip([{ name: 'project.json', data: ENC.encode(validProject) }])), pkgCode('missing-entry'));
  // Missing project.json
  await assert.rejects(parsePackage(createZip([{ name: 'manifest.json', data: ENC.encode(validManifest) }])), pkgCode('missing-entry'));

  // Unexpected extra file
  await assert.rejects(parsePackage(createZip([
    { name: 'manifest.json', data: ENC.encode(validManifest) },
    { name: 'project.json', data: ENC.encode(validProject) },
    { name: 'notes.txt', data: ENC.encode('surprise') },
  ])), pkgCode('unexpected-entry'));

  // Path traversal
  await assert.rejects(readZip(makeRawZip([{ name: '../evil.json', data: '{}' }])), zipCode('invalid'));

  // Duplicate path in archive
  const dupZip = makeRawZip([
    { name: 'manifest.json', data: validManifest },
    { name: 'project.json', data: validProject },
    { name: 'project.json', data: validProject },
  ]);
  await assert.rejects(parsePackage(dupZip), pkgCode('duplicate-entry'));

  // Duplicate sample id under two extensions in archive
  const wav = new Uint8Array(makeWav({ seconds: 0.1 }));
  const sha = await sha256Hex(wav);
  const id = `smp-${sha}`;
  const projWithSample = createEmptyProject();
  slotById(projWithSample, 'slot-05').sample = { id, name: 'a.wav', duration: 0.1, sampleRate: 44100, channels: 1, slices: defaultSlices(8) };
  const sampleManifest = JSON.stringify({
    format: PACKAGE_FORMAT, v: 1, app: APP_VERSION,
    samples: [{ id, name: 'a.wav', type: 'audio/wav', size: wav.byteLength, sha256: sha }],
  });
  const dupSampleExt = createZip([
    { name: 'manifest.json', data: ENC.encode(sampleManifest) },
    { name: 'project.json', data: ENC.encode(JSON.stringify(projWithSample)) },
    { name: `samples/${id}.wav`, data: wav },
    { name: `samples/${id}.mp3`, data: wav },
  ]);
  await assert.rejects(parsePackage(dupSampleExt), pkgCode('duplicate-entry'));

  // Missing referenced sample file from archive
  const missingSampleFile = createZip([
    { name: 'manifest.json', data: ENC.encode(sampleManifest) },
    { name: 'project.json', data: ENC.encode(JSON.stringify(projWithSample)) },
  ]);
  await assert.rejects(parsePackage(missingSampleFile), pkgCode('missing-entry'));

  // Unreferenced sample file in archive
  const unrefSampleFile = createZip([
    { name: 'manifest.json', data: ENC.encode(validManifest) },
    { name: 'project.json', data: ENC.encode(validProject) },
    { name: `samples/${id}.wav`, data: wav },
  ]);
  await assert.rejects(parsePackage(unrefSampleFile), pkgCode('unexpected-entry'));

  // Oversized archive (compressed/raw byte bound)
  const exported = await exportPackage(proj);
  await assert.rejects(parsePackage(exported.bytes, { limits: { maxArchiveBytes: 100 } }), pkgCode('too-large'));

  // Oversized uncompressed payload (DEFLATE ZIP bomb protection)
  const bigZero = new Uint8Array(20000);
  const tinyDeflated = await deflateRaw(bigZero);
  assert.ok(tinyDeflated.byteLength < 500, 'deflated payload is small');
  const bomb = makeRawZip([
    { name: 'manifest.json', data: tinyDeflated, method: 8, crc: crc32(bigZero), compSize: tinyDeflated.byteLength, uncompSize: bigZero.byteLength },
  ]);
  await assert.rejects(readZip(bomb, { maxUncompressedBytes: 4096, maxEntryBytes: 4096 }), zipCode('too-large'));

  // Oversized file pre-check in A.importFile rejects before reading bytes
  const before = store.project;
  let readCalled = false;
  const fakeHuge = { name: 'huge.hbn', size: 200 * 1024 * 1024, async arrayBuffer() { readCalled = true; return new ArrayBuffer(0); } };
  const hugeRes = await A.importFile(fakeHuge);
  assert.equal(hugeRes, null);
  assert.equal(readCalled, false, 'oversized .hbn rejected before allocating buffer');
  assert.equal(store.project, before);
});

/* ---------------------------------------------------------
   6. Manifest / version mismatch
   --------------------------------------------------------- */
test('rejects manifest format mismatch, unsupported package versions and malformed sample metadata', async () => {
  const projBytes = ENC.encode(JSON.stringify(createEmptyProject()));
  const packWithManifest = m => createZip([
    { name: 'manifest.json', data: ENC.encode(typeof m === 'string' ? m : JSON.stringify(m)) },
    { name: 'project.json', data: projBytes },
  ]);

  await assert.rejects(parsePackage(packWithManifest('{not json')), pkgCode('invalid-manifest'));
  await assert.rejects(parsePackage(packWithManifest({ format: 'wrong', v: 1, app: APP_VERSION, samples: [] })), pkgCode('invalid-manifest'));
  await assert.rejects(parsePackage(packWithManifest({ format: PACKAGE_FORMAT, v: 2, app: '1.0.0', samples: [] })), e => pkgCode('unsupported-version')(e) && /v2/.test(e.message));
  await assert.rejects(parsePackage(packWithManifest({ format: PACKAGE_FORMAT, v: 0, app: APP_VERSION, samples: [] })), pkgCode('unsupported-version'));
  await assert.rejects(parsePackage(packWithManifest({ format: PACKAGE_FORMAT, v: '1', app: APP_VERSION, samples: [] })), pkgCode('unsupported-version'));
  await assert.rejects(parsePackage(packWithManifest({ format: PACKAGE_FORMAT, v: 1, app: '', samples: [] })), pkgCode('invalid-manifest'));
  await assert.rejects(parsePackage(packWithManifest({ format: PACKAGE_FORMAT, v: 1, app: APP_VERSION, samples: 'none' })), pkgCode('invalid-manifest'));

  // Malformed sample metadata (bad size)
  const wav = new Uint8Array(makeWav({ seconds: 0.1 }));
  const sha = await sha256Hex(wav);
  const id = `smp-${sha}`;
  const projWithSample = createEmptyProject();
  slotById(projWithSample, 'slot-05').sample = { id, name: 'x.wav', duration: 0.1, sampleRate: 44100, channels: 1, slices: defaultSlices(8) };
  const wrongSizeZip = createZip([
    { name: 'manifest.json', data: ENC.encode(JSON.stringify({ format: PACKAGE_FORMAT, v: 1, app: APP_VERSION, samples: [{ id, name: 'x.wav', type: 'audio/wav', size: wav.byteLength + 10, sha256: sha }] })) },
    { name: 'project.json', data: ENC.encode(JSON.stringify(projWithSample)) },
    { name: `samples/${id}.wav`, data: wav },
  ]);
  await assert.rejects(parsePackage(wrongSizeZip), pkgCode('invalid-manifest'));
});

/* ---------------------------------------------------------
   7. Sample hash mismatch
   --------------------------------------------------------- */
test('rejects sample hash mismatch before mutating sample storage', async () => {
  const src = newSampleStore();
  const dst = newSampleStore();
  const wav = makeWav({ seconds: 0.25, freq: 440 });
  const { meta } = await src.sampleStore.importBytes({ bytes: wav, name: 'kick.wav', type: 'audio/wav' });
  const proj = createEmptyProject({ name: 'Tampered' });
  slotById(proj, 'slot-05').sample = sampleRefFor(meta);

  const exported = await exportPackage(proj, { sampleStore: src.sampleStore });
  const map = await readZip(exported.bytes);
  const path = `samples/${meta.id}.wav`;
  const tamperedAudio = map.get(path).slice();
  tamperedAudio[tamperedAudio.length - 1] ^= 0xff;
  map.set(path, tamperedAudio);
  const tamperedZip = createZip([...map.entries()].map(([name, data]) => ({ name, data })));

  await assert.rejects(importPackage(tamperedZip, { sampleStore: dst.sampleStore }), pkgCode('hash-mismatch'));
  assert.equal(dst.backend.db.bytes.size, 0, 'no samples written on hash mismatch');
  assert.equal(dst.backend.db.meta.size, 0);
});

/* ---------------------------------------------------------
   8. Interrupted or failed storage writes + non-destructive cleanup
   --------------------------------------------------------- */
test('failed sample storage write aborts import, preserves pre-existing shared assets, and cleans up newly added ones', async () => {
  const src = newSampleStore();
  const wavShared = makeWav({ seconds: 0.2, freq: 220 });
  const wavNew1 = makeWav({ seconds: 0.2, freq: 330 });
  const wavNew2 = makeWav({ seconds: 0.2, freq: 550 });

  const sShared = (await src.sampleStore.importBytes({ bytes: wavShared, name: 'shared.wav', type: 'audio/wav' })).meta;
  const sNew1 = (await src.sampleStore.importBytes({ bytes: wavNew1, name: 'new1.wav', type: 'audio/wav' })).meta;
  const sNew2 = (await src.sampleStore.importBytes({ bytes: wavNew2, name: 'new2.wav', type: 'audio/wav' })).meta;

  // Build package with 3 sampler slots: [sShared, sNew1, sNew2]
  const incoming = createEmptyProject({ name: 'Incoming 3' });
  const sids = incoming.scenes.map(s => s.id);
  const slot6 = createSlot('munch', nextSlotId(incoming), sids); incoming.slots.push(slot6);
  const slot7 = createSlot('munch', nextSlotId(incoming), sids); incoming.slots.push(slot7);
  slotById(incoming, 'slot-05').sample = sampleRefFor(sShared);
  slotById(incoming, slot6.id).sample = sampleRefFor(sNew1);
  slotById(incoming, slot7.id).sample = sampleRefFor(sNew2);
  const pkg = await exportPackage(incoming, { sampleStore: src.sampleStore });

  // Destination already holds an existing song + sShared, and quota fits sShared + sNew1 but NOT sNew2
  const quota = wavShared.byteLength + wavNew1.byteLength + 100;
  const dst = newSampleStore({ quotaBytes: quota });
  await dst.sampleStore.importBytes({ bytes: wavShared, name: 'shared.wav', type: 'audio/wav' });
  assert.equal(dst.backend.db.bytes.size, 1);

  const lib = createLibrary(memoryStorage());
  const existingSong = createDemoProject();
  existingSong.name = 'Keep Me Safe';
  slotById(existingSong, 'slot-05').sample = sampleRefFor(sShared);
  lib.save(existingSong);
  store.project = existingSong;

  const toasts = [];
  const off = on('toast', m => toasts.push(m));
  const res = await A.importFile(fakeFile('incoming.hbn', pkg.bytes), { sampleStore: dst.sampleStore, lib });
  off();

  assert.equal(res, null, 'import aborted');
  assert.equal(store.project.id, existingSong.id, 'existing active project untouched');
  assert.equal(lib.list().length, 1, 'no partial song added to library');
  assert.ok(await dst.sampleStore.has(sShared.id), 'pre-existing shared asset preserved');
  assert.equal(await dst.sampleStore.has(sNew1.id), false, 'newly written asset cleaned up non-destructively');
  assert.equal(await dst.sampleStore.has(sNew2.id), false, 'failed asset not persisted');
  assert.deepEqual(dst.sampleStore.unsaved(), [], 'failed import leaves no dangling unsaved pending samples');
  assert.ok(toasts.some(t => /new2\.wav/.test(t)));
});

test('failed persistence confirmation (has() returns false) or failed library write aborts without adopting', async () => {
  const src = newSampleStore();
  const wav = makeWav({ seconds: 0.2, freq: 440 });
  const meta = (await src.sampleStore.importBytes({ bytes: wav, name: 'tone.wav', type: 'audio/wav' })).meta;
  const proj = createEmptyProject({ name: 'Will Fail Save' });
  slotById(proj, 'slot-05').sample = sampleRefFor(meta);
  const pkg = await exportPackage(proj, { sampleStore: src.sampleStore });

  // Case A: sampleStore.has returns false after write (unconfirmed persistence)
  const dstA = newSampleStore();
  const unconfirmedStore = { ...dstA.sampleStore, has: async () => false };
  await assert.rejects(importPackage(pkg.bytes, { sampleStore: unconfirmedStore }), pkgCode('storage-error'));

  // Case B: sample store succeeds, but library.save fails (e.g. localStorage quota exceeded)
  const dstB = newSampleStore();
  const backing = memoryStorage();
  const lib = createLibrary(backing);
  const existing = createDemoProject();
  existing.name = 'Existing Song';
  lib.save(existing);
  store.project = existing;

  const failingLib = { ...lib, save: () => false };
  const res = await A.importFile(fakeFile('fail-lib.hbn', pkg.bytes), { sampleStore: dstB.sampleStore, lib: failingLib });
  assert.equal(res, null);
  assert.equal(store.project.id, existing.id, 'active project preserved');
  assert.equal(lib.currentId(), existing.id);
  assert.equal(await dstB.sampleStore.has(meta.id), false, 'newly written sample cleaned up when library save fails');
});

/* ---------------------------------------------------------
   9 & 10. Legacy JSON imports & v4/v5 migration compatibility
   --------------------------------------------------------- */
test('legacy JSON imports and v4/v5 migrations remain compatible through A.importFile and .hbn', async () => {
  const lib = createLibrary(memoryStorage());
  const initial = createDemoProject();
  initial.name = 'Initial';
  lib.save(initial);
  store.project = initial;

  // v4 JSON import
  const v4 = await A.importFile(fakeFile('v4-demo.json', fxText('v4-demo.json')), { lib });
  assert.ok(v4);
  assert.equal(v4.v, 6);
  assert.notEqual(v4.id, initial.id);
  assert.equal(v4.slots.length, 5);

  // v5 JSON import
  const v5Raw = JSON.parse(fxText('v5-edge.json'));
  const v5 = await A.importFile(fakeFile('v5-edge.json', fxText('v5-edge.json')), { lib });
  assert.ok(v5);
  assert.equal(v5.v, 6);
  assert.equal(v5.name, 'Edge case');
  assert.notEqual(v5.id, v5Raw.id, 'fresh project ID assigned');
  assert.equal(slotById(v5, 'slot-03').mute, true);
  assert.equal(v5.arrangement.length, 4);

  // v5 project.json embedded inside a .hbn package also migrates cleanly through importProject
  const v5InHbn = createZip([
    { name: 'manifest.json', data: ENC.encode(JSON.stringify({ format: PACKAGE_FORMAT, v: 1, app: APP_VERSION, samples: [] })) },
    { name: 'project.json', data: ENC.encode(fxText('v5-edge.json')) },
  ]);
  const v5Pkg = await A.importFile(fakeFile('legacy-inside.hbn', v5InHbn), { lib });
  assert.ok(v5Pkg);
  assert.equal(v5Pkg.v, 6);
  assert.equal(v5Pkg.name, 'Edge case');
  assert.equal(lib.list().length, 4, 'initial + v4 + v5 json + v5 hbn all preserved');

  // Corrupt JSON fails cleanly without touching active project
  const curId = store.project.id;
  assert.equal(await A.importFile(fakeFile('bad.json', '{broken'), { lib }), null);
  assert.equal(store.project.id, curId);
});

/* ---------------------------------------------------------
   11 & 12. Existing project preservation & repeated import without destructive duplication
   --------------------------------------------------------- */
test('repeated .hbn import assigns fresh project IDs, preserves existing songs and never duplicates samples', async () => {
  const src = newSampleStore();
  const dst = newSampleStore();
  const lib = createLibrary(memoryStorage());

  const wav = makeWav({ seconds: 0.35, freq: 261.63 });
  const { meta } = await src.sampleStore.importBytes({ bytes: wav, name: 'chord.wav', type: 'audio/wav' });

  const original = createDemoProject();
  original.name = 'Portable Beat';
  slotById(original, 'slot-05').sample = sampleRefFor(meta);
  lib.save(original);
  store.project = original;

  // Export via actions.js
  let exportedBytes = null, exportedFilename = null;
  const exp = await A.exportProject({
    sampleStore: src.sampleStore,
    download: (bytes, filename) => { exportedBytes = bytes; exportedFilename = filename; },
  });
  assert.equal(exp.ok, true);
  assert.equal(exportedFilename, 'harbumatic-portable-beat.hbn');
  assert.ok(exportedBytes instanceof Uint8Array);

  // First import into destination (which already has `original` with the same project id!)
  const first = await A.importFile(fakeFile(exportedFilename, exportedBytes), { sampleStore: dst.sampleStore, lib });
  assert.ok(first);
  assert.notEqual(first.id, original.id, 'does not overwrite original project ID');
  assert.equal(lib.list().length, 2);
  assert.equal(dst.backend.db.bytes.size, 1);

  // Second import of the exact same .hbn file
  const second = await A.importFile(fakeFile(exportedFilename, exportedBytes), { sampleStore: dst.sampleStore, lib });
  assert.ok(second);
  assert.notEqual(second.id, original.id);
  assert.notEqual(second.id, first.id);
  assert.equal(lib.list().length, 3, 'all three songs coexist in library');
  assert.equal(dst.backend.db.bytes.size, 1, 'sample bytes stored once, no duplication');
  assert.equal(dst.backend.db.meta.size, 1, 'sample metadata stored once');
  assert.deepEqual(new Uint8Array(await dst.sampleStore.getBytes(meta.id)), new Uint8Array(wav));

  // Verify original song in library is completely intact
  const loadedOriginal = lib.load(original.id);
  assert.ok(loadedOriginal);
  assert.equal(loadedOriginal.name, 'Portable Beat');
  assert.equal(slotById(loadedOriginal, 'slot-05').sample.id, meta.id);

  // Also test parse/import when extension is missing (e.g. iOS share sheet strips .hbn) via magic byte detection
  const noExt = await A.importFile(fakeFile('portable-beat', exportedBytes), { sampleStore: dst.sampleStore, lib });
  assert.ok(noExt);
  assert.equal(noExt.name, 'Portable Beat');
  assert.equal(lib.list().length, 4);
  assert.equal(dst.backend.db.bytes.size, 1);
});

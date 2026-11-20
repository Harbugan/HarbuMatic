// Local project library on top of a Storage-like object (localStorage in the browser,
// an in-memory fake in tests). Nothing ever gets deleted without an explicit call.
//
// keys:  harbumatic.v6.index      → { current: id, projects: { [id]: { name, modified } }, v5Adopted, legacyAdopted }
//        harbumatic.v6.song.<id>  → project JSON (schema v6)
//        harbumatic.v5.index / harbumatic.v5.song.<id>
//                                 → the v0.5 library: copied into the v6 keys (songs migrated to v6), never written to or
//                                   deleted from by this module, so it is always available for a retry, so an older build on the same origin (e.g. the
//                                   live site next to a PR preview) keeps opening its songs
//        harbumatic.v4            → legacy v0.4 autosave (read once for migration, never deleted)

import { importProject, ProjectError } from './project.js';
import { uid } from './util.js';

const INDEX = 'harbumatic.v6.index';
const SONG = id => `harbumatic.v6.song.${id}`;
const V5_INDEX = 'harbumatic.v5.index';
const V5_SONG = id => `harbumatic.v5.song.${id}`;
const LEGACY = 'harbumatic.v4';

export function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _map: m };
}

export function createLibrary(storage) {
  const parse = key => { try { const j = JSON.parse(storage.getItem(key) || 'null'); if (j && j.projects) return j; } catch (e) { /* corrupt index */ } return null; };
  const writeIndex = idx => { try { storage.setItem(INDEX, JSON.stringify(idx)); if (unsaved === idx) unsaved = null; return true; } catch (e) { return false; } };

  /** classify a failed storage call: quota/unavailable (a retry can succeed) vs. anything else */
  const storageFailure = e => !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.name === 'SecurityError'
    || e.code === 22 || e.code === 1014 || /quota|storage|full/i.test(String(e.message)));
  const failure = (name, reason, detail) => ({ name: String(name ?? ''), reason, detail });

  /**
   * Copy every v0.5 song that is not in the v6 library yet. Mutates idx, never touches a v0.5 key, never overwrites a
   * song that already has a v6 entry, and records each failure per project so the next launch can retry exactly those.
   */
  function migrateV5Songs(idx, first) {
    const ledger = idx.v5Migration && typeof idx.v5Migration === 'object' ? idx.v5Migration : {};
    const mig = { complete: false, migrated: { ...ledger.migrated }, failed: {} };
    idx.v5Adopted = true;
    let raw = null;
    try { raw = storage.getItem(V5_INDEX); } catch (e) { mig.indexError = failure('', storageFailure(e) ? 'storage' : 'corrupt', String(e && e.message)); }
    const old = raw == null ? null : parse(V5_INDEX);
    if (raw != null && !old && !mig.indexError) mig.indexError = failure('', 'corrupt', 'the v0.5 song list cannot be read');
    if (old) {
      if (first && old.legacyAdopted) idx.legacyAdopted = true;
      for (const [id, meta] of Object.entries(old.projects)) {
        const name = meta && meta.name;
        if (mig.migrated[id]) continue; // copied once: never overwrite it (it may have been edited) and never resurrect it if the user deleted it
        let data;
        try {
          const text = storage.getItem(V5_SONG(id));
          if (text == null) { mig.failed[id] = failure(name, 'corrupt', 'the song data is missing'); continue; }
          data = importProject(JSON.parse(text));
        } catch (e) {
          mig.failed[id] = failure(name, storageFailure(e) && !(e instanceof SyntaxError || e instanceof ProjectError) ? 'storage' : 'corrupt', String(e && e.message));
          continue;
        }
        if (idx.projects[data.id]) data.id = uid('song'); // an unrelated v6 song already owns this id: keep both
        try {
          storage.setItem(SONG(data.id), JSON.stringify(data));
        } catch (e) { mig.failed[id] = failure(name, 'storage', String(e && e.message)); continue; }
        idx.projects[data.id] = { name: data.name, modified: data.modified ?? (meta && meta.modified) };
        mig.migrated[id] = data.id;
        if (first && old.current === id && !idx.current) idx.current = data.id;
      }
    }
    mig.complete = !Object.keys(mig.failed).length && !mig.indexError;
    idx.v5Migration = mig;
    return idx;
  }

  let checked = false;   // the v0.5 ledger is reconciled once per launch (= per library instance)
  let unsaved = null;    // index we could not persist after a migration: used as the truth for this session
  function adoptV5() {
    checked = true;
    const idx = migrateV5Songs({ current: null, projects: {} }, true);
    if (!writeIndex(idx)) unsaved = idx;
    return idx;
  }
  const readIndex = () => {
    if (unsaved) return unsaved;
    const idx = parse(INDEX);
    if (idx) {
      // an index from before the ledger existed (v5Adopted without v5Migration) or an incomplete migration: reconcile / retry once
      if (!checked) {
        checked = true;
        const m = idx.v5Migration;
        if (!m || !m.complete) { migrateV5Songs(idx, false); if (!writeIndex(idx)) unsaved = idx; }
      }
      return idx;
    }
    if (storage.getItem(INDEX) == null) return adoptV5(); // never created yet
    return { current: null, projects: {}, v5Adopted: true }; // corrupt index: rebuild, never re-import
  };

  const lib = {
    list() {
      const idx = readIndex();
      return Object.entries(idx.projects).map(([id, m]) => ({ id, ...m, current: id === idx.current }))
        .sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
    },
    currentId: () => readIndex().current,
    /** state of the v0.5 → v6 copy: { complete, failed: [{ id, name, reason, detail }], storage, corrupt } */
    migrationStatus() {
      const m = readIndex().v5Migration || { complete: true, failed: {} };
      const failed = Object.entries(m.failed || {}).map(([id, f]) => ({ id, ...f }));
      if (m.indexError) failed.push({ id: '', ...m.indexError });
      return { complete: !!m.complete, failed, storage: failed.filter(f => f.reason === 'storage').length, corrupt: failed.filter(f => f.reason === 'corrupt').length };
    },
    /** one-line warning for the user when some v0.5 songs could not be copied (null when everything is in) */
    migrationWarning() {
      const st = lib.migrationStatus();
      if (!st.failed.length) return null;
      const n = st.failed.length, songs = n === 1 ? '1 song' : `${n} songs`;
      const why = st.storage && st.corrupt ? 'storage is full or damaged data'
        : st.storage ? 'browser storage is full or unavailable' : 'damaged data';
      return `${songs} from the previous version could not be copied (${why}). The originals are untouched; we will retry next time you open HarbuMatic.`;
    },
    /** persist a project; returns false when storage is full/unavailable */
    save(project) {
      try {
        const idx = readIndex();
        storage.setItem(SONG(project.id), JSON.stringify(project));
        idx.projects[project.id] = { name: project.name, modified: project.modified };
        idx.current = project.id;
        return writeIndex(idx);
      } catch (e) { return false; }
    },
    load(id) {
      try {
        readIndex();
        const raw = storage.getItem(SONG(id));
        if (!raw) return null;
        return importProject(JSON.parse(raw));
      } catch (e) { return null; }
    },
    setCurrent(id) { const idx = readIndex(); idx.current = id; writeIndex(idx); },
    remove(id) {
      const idx = readIndex();
      delete idx.projects[id];
      if (idx.current === id) idx.current = null;
      try { storage.removeItem(SONG(id)); } catch (e) { /* ignore */ }
      writeIndex(idx);
    },
    /** One-time adoption of a v0.4 autosave. The legacy key itself is left untouched. */
    adoptLegacy() {
      const idx = readIndex();
      if (idx.legacyAdopted) return null;
      let project = null;
      try {
        const raw = storage.getItem(LEGACY);
        if (raw) project = importProject(JSON.parse(raw));
      } catch (e) { if (!(e instanceof ProjectError)) project = null; }
      idx.legacyAdopted = true; writeIndex(idx);
      if (project) { project.name = 'My v0.4 jam'; lib.save(project); }
      return project;
    },
  };
  return lib;
}

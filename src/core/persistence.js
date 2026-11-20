// Local project library on top of a Storage-like object (localStorage in the browser,
// an in-memory fake in tests). Nothing ever gets deleted without an explicit call.
//
// keys:  harbumatic.v6.index      → { current: id, projects: { [id]: { name, modified } }, v5Adopted, legacyAdopted }
//        harbumatic.v6.song.<id>  → project JSON (schema v6)
//        harbumatic.v5.index / harbumatic.v5.song.<id>
//                                 → the v0.5 library: copied into the v6 keys once (songs migrated to v6),
//                                   then left untouched, so an older build on the same origin (e.g. the
//                                   live site next to a PR preview) keeps opening its songs
//        harbumatic.v4            → legacy v0.4 autosave (read once for migration, never deleted)

import { importProject, ProjectError } from './project.js';

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
  const writeIndex = idx => { try { storage.setItem(INDEX, JSON.stringify(idx)); return true; } catch (e) { return false; } };

  /** first run of the v6 library: copy (and migrate) every v0.5 song, keep the v0.5 keys as they are */
  function adoptV5() {
    const idx = { current: null, projects: {}, v5Adopted: true };
    const old = parse(V5_INDEX);
    if (old) {
      if (old.legacyAdopted) idx.legacyAdopted = true;
      for (const [id, meta] of Object.entries(old.projects)) {
        try {
          const raw = storage.getItem(V5_SONG(id));
          if (!raw) continue;
          const p = importProject(JSON.parse(raw));
          storage.setItem(SONG(p.id), JSON.stringify(p));
          idx.projects[p.id] = { name: p.name, modified: p.modified ?? meta.modified };
        } catch (e) { /* unreadable song: stays in the v0.5 keys, untouched */ }
      }
      if (old.current && idx.projects[old.current]) idx.current = old.current;
    }
    writeIndex(idx);
    return idx;
  }
  const readIndex = () => {
    const idx = parse(INDEX);
    if (idx) return idx;
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

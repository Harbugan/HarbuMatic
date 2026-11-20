// Local project library on top of a Storage-like object (localStorage in the browser,
// an in-memory fake in tests). Nothing ever gets deleted without an explicit call.
//
// keys:  harbumatic.v5.index   → { current: id, projects: { [id]: { name, modified } } }
//        harbumatic.v5.song.<id> → project JSON
//        harbumatic.v4          → legacy v0.4 autosave (read once for migration, never deleted)

import { importProject, ProjectError } from './project.js';

const INDEX = 'harbumatic.v5.index';
const SONG = id => `harbumatic.v5.song.${id}`;
const LEGACY = 'harbumatic.v4';

export function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _map: m };
}

export function createLibrary(storage) {
  const readIndex = () => {
    try { const j = JSON.parse(storage.getItem(INDEX) || 'null'); if (j && j.projects) return j; } catch (e) { /* corrupt index: rebuild */ }
    return { current: null, projects: {} };
  };
  const writeIndex = idx => { try { storage.setItem(INDEX, JSON.stringify(idx)); return true; } catch (e) { return false; } };

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
        storage.setItem(SONG(project.id), JSON.stringify(project));
        const idx = readIndex();
        idx.projects[project.id] = { name: project.name, modified: project.modified };
        idx.current = project.id;
        return writeIndex(idx);
      } catch (e) { return false; }
    },
    load(id) {
      try {
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

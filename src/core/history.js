// Snapshot-based undo/redo over the whole project JSON.
// Continuous gestures (knob drags, tempo drags, wheel) pass a `coalesce` key so a burst
// of changes produces a single history entry.

export function createHistory({ limit = 120, coalesceMs = 900, now = () => Date.now() } = {}) {
  const undoStack = [], redoStack = [];
  let lastKey = null, lastAt = 0;
  return {
    /** call BEFORE mutating; `snapshot` is the current project serialised */
    checkpoint(snapshot, coalesce = null) {
      const t = now();
      if (coalesce && coalesce === lastKey && t - lastAt < coalesceMs) { lastAt = t; return false; }
      undoStack.push(snapshot);
      if (undoStack.length > limit) undoStack.shift();
      redoStack.length = 0;
      lastKey = coalesce; lastAt = t;
      return true;
    },
    undo(current) { if (!undoStack.length) return null; redoStack.push(current); lastKey = null; return undoStack.pop(); },
    redo(current) { if (!redoStack.length) return null; undoStack.push(current); lastKey = null; return redoStack.pop(); },
    clear() { undoStack.length = 0; redoStack.length = 0; lastKey = null; },
    /** break coalescing explicitly, e.g. on pointerup */
    seal() { lastKey = null; },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    get size() { return undoStack.length; },
  };
}

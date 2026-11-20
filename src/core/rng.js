// Seedable random number generator (mulberry32).
// All music generation takes an rng instance so results are reproducible in tests.

export function createRng(seed = randomSeed()) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    seed,
    next,
    float: (lo = 0, hi = 1) => lo + next() * (hi - lo),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: p => next() < p,
    pick: arr => arr[Math.floor(next() * arr.length)],
    /** pick from items using parallel weights */
    weighted(items, weights) {
      const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
      if (total <= 0) return items[0];
      let r = next() * total;
      for (let i = 0; i < items.length; i++) { r -= Math.max(0, weights[i]); if (r < 0) return items[i]; }
      return items[items.length - 1];
    },
    shuffle(arr) {
      const a2 = [...arr];
      for (let i = a2.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a2[i], a2[j]] = [a2[j], a2[i]]; }
      return a2;
    },
    /** derive an independent child stream (keeps sub-generators stable when others change) */
    fork: salt => createRng((seed ^ hashString(String(salt))) >>> 0),
  };
  return rng;
}

export const randomSeed = () => (Math.random() * 4294967296) >>> 0;

export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

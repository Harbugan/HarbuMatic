// Small, dependency-free helpers shared by every layer (no DOM, no audio).

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const clone = o => JSON.parse(JSON.stringify(o));
export const mod = (n, m) => ((n % m) + m) % m;
export const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
export const lcm = (a, b) => (a && b ? Math.abs(a * b) / gcd(a, b) : Math.max(a, b));
export const range = n => [...Array(n).keys()];
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export const isObj = o => o != null && typeof o === 'object' && !Array.isArray(o);
export const num = (v, def, lo = -Infinity, hi = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : def);

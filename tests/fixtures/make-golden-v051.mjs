// Freezes v5 fixtures + scheduler dispatch logs from the v0.5.1 code (commit b73cf8c).
// Usage (against a checkout of that commit): node tests/fixtures/make-golden-v051.mjs <v0.5.1-checkout> tests/fixtures
// The outputs are golden references for the v6 migration and scheduler tests; do not regenerate them from newer code.
import { writeFileSync, readFileSync } from 'node:fs';
const root = process.argv[2], out = process.argv[3];
const P = await import(root + '/src/core/project.js');
const { createTransport } = await import(root + '/src/audio/scheduler.js');
const { TRACKS } = await import(root + '/src/core/constants.js');
const { clone } = await import(root + '/src/core/util.js');

const v4 = JSON.parse(readFileSync(root + '/tests/fixtures/v4-demo.json', 'utf8'));
const fromV4 = P.importProject(v4);
const demo = P.createDemoProject();
// an edge-case v5 song exercising every field
const edge = P.validateProject(clone(demo));
edge.name = 'Edge case'; edge.bpm = 131; edge.swing = .23; edge.key = 2; edge.scale = 'dorian'; edge.scene = 4; edge.songMode = true;
edge.scenes[4].name = 'Peak'; edge.scenes[5].harmony = { degrees: [0, 3, 4], span: 64 };
edge.tracks.synth.mute = true; edge.tracks.fuzz.solo = false; edge.tracks.bass.solo = false;
edge.tracks.drums.patterns[4] = clone(edge.tracks.drums.patterns[2]); edge.tracks.drums.patterns[4].locked = { kick: true, rim: true };
edge.tracks.bass.patterns[4] = { len: 64, notes: [{ s: 0, p: 33, l: 2, v: .95, slide: true }, { s: 2, p: 36, l: 1, v: .7 }, { s: 7, p: 40, l: 3, v: .5, pr: .5, o: .2, locked: true }, { s: 30, p: 45, l: 2, v: 1 }, { s: 63, p: 31, l: 1, v: .6, slide: true }] };
edge.tracks.synth.patterns[4] = { len: 16, notes: [{ s: 0, p: 60, l: 4, v: .6, o: -.15 }, { s: 0, p: 64, l: 4, v: .6 }, { s: 8, p: 67, l: 8, v: .9, pr: .75, locked: true }] };
edge.tracks.fuzz.patterns[4] = { len: 32, notes: [{ s: 4, p: 76, l: 20, v: .5 }] };
edge.tracks.bass.params.res = .91; edge.tracks.bass.params.wave = 'square'; edge.tracks.drums.params.kit = 'lofi'; edge.tracks.fuzz.params.crush = .6;
edge.tracks.synth.macros = { brightness: .1, movement: .9, space: .3, character: .7 };
edge.arrangement = [P.newBlock(4, 2), P.newBlock(0), P.newBlock(5, 3), P.newBlock(4)];
edge.snaps[0] = { tracks: TRACKS.map(t => clone(edge.tracks[t].patterns[1])), macros: TRACKS.map(t => clone(edge.tracks[t].macros)) };
edge.snaps[2] = { tracks: TRACKS.map(t => clone(edge.tracks[t].patterns[4])), macros: TRACKS.map((t, k) => ({ brightness: k / 4, movement: .5, space: .2, character: .8 })) };
edge.lab = { chaos: .8, density: .3, mood: 'weird', targets: { pitch: false, rhythm: true, velocity: true, length: true, sound: false } };
edge.fx = { fb: .6, dtone: .3, rev: 1.1, master: .7 };
const edgeV = P.validateProject(edge);

const fixtures = { 'v5-demo.json': P.validateProject(demo), 'v5-from-v4.json': fromV4, 'v5-edge.json': edgeV };
for (const [f, p] of Object.entries(fixtures)) writeFileSync(out + '/' + f, JSON.stringify(p, null, 1) + '\n');

// ---- scheduler dispatch logs ----
const SCEN = [
  { name: 'demo loop scene B', fixture: 'v5-demo.json', steps: 160, seed: 1, set: { scene: 1, songMode: false } },
  { name: 'demo song mode', fixture: 'v5-demo.json', steps: 260, seed: 2, set: { songMode: true } },
  { name: 'demo queued scene switch', fixture: 'v5-demo.json', steps: 120, seed: 3, set: { scene: 0, songMode: false }, queue: { 21: 2, 70: 1 } },
  { name: 'demo mute synth', fixture: 'v5-demo.json', steps: 64, seed: 4, set: { scene: 2, songMode: false }, mute: ['synth'] },
  { name: 'demo solo bass + fuzz', fixture: 'v5-demo.json', steps: 64, seed: 5, set: { scene: 1, songMode: false }, solo: ['bass', 'fuzz'], mute: ['bass'] },
  { name: 'edge song (swing, offsets, chance, slides, 64 steps)', fixture: 'v5-edge.json', steps: 400, seed: 6, set: {} },
  { name: 'edge loop scene E', fixture: 'v5-edge.json', steps: 140, seed: 7, set: { songMode: false, scene: 4 }, mute: [] , unmute: ['synth'] },
  { name: 'migrated v0.4 song mode', fixture: 'v5-from-v4.json', steps: 200, seed: 8, set: { songMode: true } },
];
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r6 = x => Math.round(x * 1e6) / 1e6;
const logs = [];
for (const sc of SCEN) {
  const project = clone(fixtures[sc.fixture]);
  Object.assign(project, sc.set);
  (sc.mute || []).forEach(t => { project.tracks[t].mute = true; });
  (sc.unmute || []).forEach(t => { project.tracks[t].mute = false; });
  (sc.solo || []).forEach(t => { project.tracks[t].solo = true; });
  const calls = []; let tag = () => 0;
  const ctx = { currentTime: 0 };
  const engine = {
    ctx, init: () => ctx, openGates() {}, closeGates() {}, stepDur: () => 60 / project.bpm / 4,
    audible: t => { const any = TRACKS.some(x => project.tracks[x].solo); return any ? project.tracks[t].solo : !project.tracks[t].mute; },
    playDrum: (id, t, v) => calls.push([tag(), 'd', 'drums', r6(t), id, v]),
    playNote: (tr, t, n, dur, si, so) => calls.push([tag(), 'n', tr, r6(t), n.p, n.v, r6(dur), !!si, !!so]),
  };
  let tickFn = null; const si = globalThis.setInterval, ci = globalThis.clearInterval;
  globalThis.setInterval = fn => { tickFn = fn; return 1; }; globalThis.clearInterval = () => {};
  const mr = Math.random; Math.random = mulberry(sc.seed);
  const tr = createTransport(engine, () => project, {});
  tr.play();
  const events = [];
  tag = () => events.length + tr.queue.length;
  let guard = 0;
  while (events.length + tr.queue.length < sc.steps && guard++ < 100000) {
    const n = events.length + tr.queue.length;
    if (sc.queue && sc.queue[n] != null && !sc.queue['_' + n]) { sc.queue['_' + n] = 1; tr.queueScene(sc.queue[n]); }
    ctx.currentTime += .01; tickFn();
    events.push(...tr.queue.splice(0));
  }
  tr.stop();
  Math.random = mr; globalThis.setInterval = si; globalThis.clearInterval = ci;
  logs.push({ name: sc.name, scenario: sc, events: events.slice(0, sc.steps).map(e => ({ t: r6(e.time), step: e.step, scene: e.scene, block: e.block, song: e.song, hits: e.hits })), calls: calls.filter(c => c[0] < sc.steps) });
}
for (const l of logs) if (l.scenario.queue) for (const k of Object.keys(l.scenario.queue)) if (k[0] === '_') delete l.scenario.queue[k];
writeFileSync(out + '/dispatch-v051.json', JSON.stringify(logs) + '\n');
console.log(logs.map(l => `${l.name}: ${l.events.length} steps, ${l.calls.length} calls`).join('\n'));

// ---- generator output (Generate on every instrument, seeded) ----
const { createRng } = await import(root + '/src/core/rng.js');
const { buildContext } = await import(root + '/src/music/context.js');
const { transformPattern } = await import(root + '/src/music/transform.js');
const gen = [];
for (const mood of ['dreamy', 'bouncy', 'dark', 'weird']) for (const seed of [1, 2, 3]) {
  const rng = createRng(seed * 31 + mood.length);
  const pr = P.createEmptyProject({ key: seed + 2, scale: ['minor', 'dorian', 'major'][seed - 1], mood });
  Object.assign(pr.lab, { mood, chaos: seed / 4, density: .3 + seed / 6 });
  for (const t of TRACKS) {
    const ctx = buildContext(pr, 0, { rng, forLen: pr.tracks[t].patterns[0].len, ensureHarmony: t !== 'drums' });
    if (ctx.harmonyNew) pr.scenes[0].harmony = ctx.harmony;
    pr.tracks[t].patterns[0] = transformPattern('generate', t, pr.tracks[t].patterns[0], ctx, rng).pattern;
  }
  for (const kind of ['mutate', 'remix', 'callresp', 'humanize']) {
    const ctx = buildContext(pr, 0, { rng, forLen: 32 });
    pr.tracks.synth.patterns[1] = transformPattern(kind, 'synth', pr.tracks.synth.patterns[0], ctx, rng).pattern;
  }
  gen.push({ mood, seed, harmony: pr.scenes[0].harmony, patterns: Object.fromEntries(TRACKS.map(t => [t, pr.tracks[t].patterns[0]])), synth1: pr.tracks.synth.patterns[1] });
}
writeFileSync(out + '/generate-v051.json', JSON.stringify(gen) + '\n');
console.log(`generator: ${gen.length} scenes`);

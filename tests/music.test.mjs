import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyProject, createDemoProject } from '../src/core/project.js';
import { createRng } from '../src/core/rng.js';
import { buildContext } from '../src/music/context.js';
import { transformPattern, KINDS } from '../src/music/transform.js';
import { genBass, genDrums } from '../src/music/generate.js';
import { chooseHarmony, chordsHeard, chordName, usableDegrees, inferHarmony } from '../src/music/harmony.js';
import { makeScale } from '../src/music/theory.js';
import { euclid } from '../src/music/rhythm.js';
import * as A from '../src/music/analysis.js';
import { DRUM_IDS, MOODS, SCALES } from '../src/core/constants.js';

const SEEDS = 30;

/** generate a whole scene (drums → bass → synth → fuzz) like a user pressing Generate on each */
function genScene(seed, { mood = 'bouncy', chaos = .3, density = .55, key = 9, scale = 'minor' } = {}) {
  const rng = createRng(seed);
  const pr = createEmptyProject({ key, scale, mood });
  Object.assign(pr.lab, { mood, chaos, density });
  for (const t of ['drums', 'bass', 'synth', 'fuzz']) {
    const ctx = buildContext(pr, 0, { rng, forLen: pr.tracks[t].patterns[0].len, ensureHarmony: t !== 'drums' });
    if (ctx.harmonyNew) pr.scenes[0].harmony = ctx.harmony;
    pr.tracks[t].patterns[0] = transformPattern('generate', t, pr.tracks[t].patterns[0], ctx, rng).pattern;
  }
  return { pr, ctx: buildContext(pr, 0, { rng }) };
}
const avg = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

test('rng is deterministic per seed', () => {
  const a = createRng(42), b = createRng(42), c = createRng(43);
  const sa = Array.from({ length: 5 }, a.next), sb = Array.from({ length: 5 }, b.next), sc = Array.from({ length: 5 }, c.next);
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
});

test('generation is reproducible with the same seed', () => {
  assert.deepEqual(genScene(7).pr.tracks, genScene(7).pr.tracks);
});

test('scale helpers', () => {
  const sc = makeScale(9, 'minor');
  assert.equal(sc.step(57, 1), 59);
  assert.equal(sc.step(57, -1), 55);
  assert.ok(sc.inScale(sc.snap(58)));
  assert.equal(sc.dist(57, 64), 4);
});

test('euclidean rhythms have the right number of hits', () => {
  for (const [k, n] of [[3, 8], [5, 16], [7, 16], [4, 16]]) assert.equal(euclid(k, n).filter(Boolean).length, k);
  assert.ok(euclid(3, 8)[0]);
});

test('harmony: progressions avoid diminished chords and out-of-scale roots', () => {
  for (const scale of Object.keys(SCALES)) for (const mood of ['dreamy', 'bouncy', 'dark']) for (let s = 0; s < 20; s++) {
    const h = chooseHarmony(createRng(s), { key: 2, scale, mood, chaos: .9, span: 32 });
    const ok = usableDegrees(2, scale, false);
    assert.ok(h.degrees.every(d => ok.includes(d)), `${scale}/${mood}: ${h.degrees}`);
    assert.equal(h.degrees[0], 0, 'progressions start on the tonic');
    assert.equal(h.span % h.degrees.length, 0);
  }
  assert.equal(chordName(9, 'minor', 0), 'Am');
  assert.equal(chordName(9, 'minor', 5), 'F');
});

test('harmony: chordsHeard handles loops shorter than the progression', () => {
  const h = { degrees: [0, 5, 2, 6], span: 32 };
  assert.deepEqual(chordsHeard(h, 0, 32), [0]);
  assert.deepEqual(chordsHeard(h, 0, 16), [0, 2]);
  assert.deepEqual(chordsHeard(h, 8, 64), [5]);
});

test('harmony can be inferred from an existing bass line (v0.4 demo groove)', () => {
  const pr = createDemoProject();
  const pats = { bass: pr.tracks.bass.patterns[1], synth: { notes: [] }, fuzz: { notes: [] } };
  const h = inferHarmony(9, 'minor', pats, 16, 2);
  assert.equal(h.degrees[0], 0, 'A-rooted bass → tonic chord');
});

test('bass and melody share the harmony: strong-beat notes are chord tones', () => {
  for (const mood of MOODS) for (const chaos of [.1, .5]) {
    const synth = [], bass = [];
    for (let s = 1; s <= SEEDS; s++) {
      const { pr, ctx } = genScene(s * 101, { mood, chaos });
      synth.push(A.chordToneRatio(pr.tracks.synth.patterns[0].notes, ctx, pr.tracks.synth.patterns[0].len));
      bass.push(A.chordToneRatio(pr.tracks.bass.patterns[0].notes, ctx, pr.tracks.bass.patterns[0].len));
    }
    assert.ok(avg(bass) > .9, `${mood}/${chaos} bass chord tones ${avg(bass).toFixed(2)}`);
    assert.ok(avg(synth) > (chaos < .3 ? .9 : .8), `${mood}/${chaos} synth chord tones ${avg(synth).toFixed(2)}`);
  }
});

test('melodies are motif based: repetition, smooth contour, resolved endings', () => {
  for (const mood of ['bouncy', 'dark', 'weird']) {
    const sim = [], smooth = [], res = [];
    for (let s = 1; s <= SEEDS; s++) {
      const { pr, ctx } = genScene(s * 31, { mood, chaos: .2 });
      const p = pr.tracks.synth.patterns[0];
      sim.push(A.unitSimilarity(p.notes, p.len, 8)); smooth.push(A.smoothness(p.notes)); res.push(A.endsResolved(p.notes, ctx, p.len) ? 1 : 0);
    }
    assert.ok(avg(sim) > .8, `${mood} repetition ${avg(sim).toFixed(2)}`);
    assert.ok(avg(smooth) > .75, `${mood} smoothness ${avg(smooth).toFixed(2)}`);
    assert.ok(avg(res) > .9, `${mood} resolution ${avg(res).toFixed(2)}`);
  }
});

test('chaos controls deviation: more chaos → less repetition, but still mostly in scale', () => {
  const simAt = chaos => avg(Array.from({ length: SEEDS }, (_, s) => { const p = genScene(s * 17 + 3, { mood: 'bouncy', chaos }).pr.tracks.synth.patterns[0]; return A.unitSimilarity(p.notes, p.len, 8); }));
  assert.ok(simAt(.05) > simAt(.95), 'low chaos repeats more than high chaos');
  for (let s = 1; s <= SEEDS; s++) {
    const { pr, ctx } = genScene(s, { mood: 'weird', chaos: 1 });
    assert.ok(A.inScaleRatio(pr.tracks.synth.patterns[0].notes, ctx.scale) >= .75);
  }
});

test('density controls how busy patterns are', () => {
  const busy = d => avg(Array.from({ length: SEEDS }, (_, s) => { const g = genScene(s * 13 + 1, { density: d }).pr; return A.onsetDensity(g.tracks.synth.patterns[0].notes, 32) + A.drumDensity(g.tracks.drums.patterns[0].steps, 16); }));
  assert.ok(busy(.9) > busy(.1));
});

test('drums: groove fundamentals per mood', () => {
  for (const mood of MOODS) for (let s = 1; s <= SEEDS; s++) {
    const ctx = { mood, density: .5, chaos: .3 };
    const st = genDrums(ctx, createRng(s), 32);
    assert.ok(st.kick[0] && st.kick[16], `${mood}: kick on every bar's downbeat`);
    if (mood !== 'weird') {
      const back = [...A.drumHits(st, 'snare'), ...A.drumHits(st, 'clap'), ...A.drumHits(st, 'rim')].map(i => i % 16);
      assert.ok(back.includes(4) || back.includes(8) || back.includes(12), `${mood}: has a backbeat`);
    }
    if (mood === 'bouncy') assert.deepEqual(A.drumHits(st, 'kick').filter(i => i < 16 && i % 4 === 0), [0, 4, 8, 12]);
  }
});

test('bass locks to the kick when using the lock style', () => {
  for (let s = 1; s <= SEEDS; s++) {
    const { pr } = genScene(s, { mood: 'dark' });
    const ctx = buildContext(pr, 0, { rng: createRng(s) });
    const notes = genBass(ctx, createRng(s), 32, 'lock');
    const onKick = notes.filter(n => ctx.kickAt(n.s)).length;
    assert.ok(onKick / notes.length >= .4, `seed ${s}: ${onKick}/${notes.length} on kicks`);
    assert.ok(ctx.kickAt(0) ? notes.some(n => n.s === 0) : true);
  }
});

test('GOO stays monophonic and slides only into adjacent notes', () => {
  for (let s = 1; s <= SEEDS; s++) {
    const p = genScene(s, { mood: 'weird', chaos: .8 }).pr.tracks.bass.patterns[0];
    const sorted = [...p.notes].sort((a, b) => a.s - b.s);
    sorted.forEach((n, i) => { const nx = sorted[i + 1]; if (nx) assert.ok(n.s + n.l <= nx.s, 'no overlap'); if (n.slide) assert.ok(sorted.some(m => m.s === (n.s + n.l) % p.len)); });
  }
});

test('every transform keeps notes inside the pattern and respects locks', () => {
  for (const track of ['drums', 'bass', 'synth', 'fuzz']) for (const kind of KINDS) for (let s = 1; s <= 12; s++) {
    const { pr } = genScene(s * 7, { chaos: .9 });
    const pat = pr.tracks[track].patterns[0];
    if (track === 'drums') { pat.locked.kick = true; pat.locked.chh = true; }
    else pat.notes.forEach((n, i) => { if (i % 3 === 0) n.locked = true; });
    const before = JSON.parse(JSON.stringify(pat));
    const ctx = buildContext(pr, 0, { rng: createRng(s) });
    const { pattern } = transformPattern(kind, track, pat, ctx, createRng(s * 3));
    assert.deepEqual(pat, before, 'input pattern is not mutated');
    if (track === 'drums') {
      assert.deepEqual(pattern.steps.kick, before.steps.kick, `${kind}: locked kick row unchanged`);
      assert.deepEqual(pattern.steps.chh, before.steps.chh, `${kind}: locked hat row unchanged`);
      DRUM_IDS.forEach(id => assert.equal(pattern.steps[id].length, pattern.len));
    } else {
      const lockedBefore = before.notes.filter(n => n.locked);
      lockedBefore.forEach(m => assert.ok(pattern.notes.some(n => n.locked && n.s === m.s && n.p === m.p && n.l === m.l), `${track}/${kind}: locked note kept`));
      pattern.notes.forEach(n => { assert.ok(n.s >= 0 && n.s < pattern.len); assert.ok(n.l >= 1 && n.s + n.l <= pattern.len); assert.ok(n.v > 0 && n.v <= 1); });
    }
  }
});

test('mutate preserves identity, evolve is subtle', () => {
  const kept = { mutate: [], evolve: [] };
  for (let s = 1; s <= SEEDS; s++) {
    const { pr } = genScene(s * 5, { chaos: .3 });
    const pat = pr.tracks.synth.patterns[0];
    for (const kind of ['mutate', 'evolve']) {
      const ctx = buildContext(pr, 0, { rng: createRng(s) });
      const out = transformPattern(kind, 'synth', pat, ctx, createRng(s + 99)).pattern;
      const same = pat.notes.filter(n => out.notes.some(m => m.s === n.s && m.p === n.p)).length / pat.notes.length;
      kept[kind].push(same);
    }
  }
  assert.ok(avg(kept.mutate) > .6, `mutate keeps ${avg(kept.mutate).toFixed(2)}`);
  assert.ok(avg(kept.evolve) > .85, `evolve keeps ${avg(kept.evolve).toFixed(2)}`);
  assert.ok(avg(kept.evolve) > avg(kept.mutate));
});

test('remix keeps notes on the harmony at their new position', () => {
  const r = [];
  for (let s = 1; s <= SEEDS; s++) {
    const { pr, ctx } = genScene(s * 3, { chaos: .2 });
    const out = transformPattern('remix', 'synth', pr.tracks.synth.patterns[0], ctx, createRng(s)).pattern;
    r.push(A.chordToneRatio(out.notes, ctx, out.len));
  }
  assert.ok(avg(r) > .75, `remix chord tones ${avg(r).toFixed(2)}`);
});

test('empty pattern + mutate falls back to generate', () => {
  const pr = createEmptyProject();
  const ctx = buildContext(pr, 0, { rng: createRng(1), forLen: 32 });
  const out = transformPattern('mutate', 'synth', pr.tracks.synth.patterns[0], ctx, createRng(2));
  assert.ok(out.pattern.notes.length > 0);
});

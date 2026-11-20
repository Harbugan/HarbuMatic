// Compare the app against a baseline build (e.g. the previous release) in headless Chromium:
//
//   1. Audio: renders the same songs offline through the real engine + transport of both builds
//      (OfflineAudioContext, seeded Math.random, scheduler driven on a virtual clock) and compares the
//      output sample by sample. Synthesis, timing, swing, mute/solo and routing must be unchanged.
//   2. Pixels: screenshots of JAM, Deep edit, SOUND (every instrument) and ARRANGE with the transport
//      stopped and motion reduced, compared pixel by pixel.
//
// Without a baseline it only checks that every instrument slot produces sound on its own.
//
//   npm run dev                                                     (current build on :5173)
//   PORT=5174 node tools/serve.mjs <checkout of the baseline>       (baseline on :5174)
//   HARBU_BASELINE_URL=http://localhost:5174/ node tools/baseline-compare.mjs
//
// Exit code 1 when a check fails. Not a substitute for listening on a real device.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.error('Playwright not found. Install it with: npm i -D playwright && npx playwright install chromium'); process.exit(2); }

const APP = process.env.HARBU_URL || 'http://localhost:5173/';
const BASE = process.env.HARBU_BASELINE_URL || '';
const SR = 22050;
// Chromium's offline rendering is not bit-for-bit repeatable here: rendering the *same* build twice
// differs by up to ~3e-5 per sample (rms ~2e-7), i.e. below -85 dB. A real change in synthesis, timing
// or routing shows up orders of magnitude above these limits (a one-sample shift alone gives > 1e-2).
const MAX_DIFF = 1e-4, RMS_DIFF = 1e-6;
const EDGE = readFileSync(new URL('../tests/fixtures/v5-edge.json', import.meta.url), 'utf8');
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failures++; };

/** installed before any app script: offline audio on a virtual clock, seeded randomness, manual scheduler ticks */
const AUDIO_SHIM = ({ SR, SECS, seed }) => {
  let a = seed >>> 0;
  Math.random = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  window.__now = 0;
  class VirtualClockContext extends OfflineAudioContext {
    constructor() { super(2, Math.ceil(SR * SECS), SR); window.__ctx = this; }
    get currentTime() { return window.__now; }
    get state() { return 'running'; }
    resume() { return Promise.resolve(); }
  }
  window.AudioContext = window.webkitAudioContext = VirtualClockContext;
  window.__ticks = [];
  window.setInterval = (fn, ms) => { if (ms === 25) window.__ticks.push(fn); return -1; }; // only the scheduler runs, by hand
};

async function render(browser, url, scen) {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(AUDIO_SHIM, { SR, SECS: scen.secs, seed: 7 });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url + (scen.query || '')); await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.click('#startBtn'); // boots the engine (and plays the demo)
  const out = await page.evaluate(async ({ scen, EDGE }) => {
    const { A, store } = window.__harbu;
    if (scen.edge) { A.stop(); await A.importFile(new File([EDGE], 'edge.json')); }
    if (scen.munch) { // a 1 s, 220 Hz WAV on MUNCH with a slice + melodic pattern in the demo's scene B
      A.stop();
      const rate = 22050, n = rate, b = new ArrayBuffer(44 + n * 2), v = new DataView(b), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 220 * i / rate) * 12000), true);
      const meta = await A.importSampleFile(new File([b], 'sine.wav', { type: 'audio/wav' }), 'slot-05');
      if (!meta) throw new Error('MUNCH import failed');
      const p = store.project; p.songMode = false; p.scene = 1;
      p.slots.forEach(s => { s.solo = s.id === 'slot-05'; });
      p.slots[4].patterns[p.scenes[1].id] = { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .9, slice: 0 }, { s: 4, p: 60, l: 1, v: .9, slice: 5 }, { s: 8, p: 67, l: 4, v: .8 }] };
      A.engine.applyAll();
    }
    const p = store.project;
    if (scen.songMode != null) { A.stop(); p.songMode = scen.songMode; if (scen.scene != null) p.scene = scen.scene; }
    if (scen.solo != null) { // solo one instrument, addressed by position so both schemas work
      A.stop();
      const list = p.slots || ['drums', 'bass', 'synth', 'fuzz'].map(t => p.tracks[t]);
      list.forEach((s, i) => { s.solo = i === scen.solo; s.mute = false; });
      A.engine.applyAll();
    }
    if (A.transport.state !== 'playing') A.transport.play();
    for (let t = 0; t < scen.secs - .4; t += .01) { window.__now = t; window.__ticks[window.__ticks.length - 1](); }
    const buf = await window.__ctx.startRendering();
    const toB64 = f => { const u = new Uint8Array(f.buffer); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
    return [toB64(buf.getChannelData(0)), toB64(buf.getChannelData(1))];
  }, { scen, EDGE });
  await ctx.close();
  if (errors.length) throw new Error(`${url}: ${errors[0]}`);
  return out.map(b => new Float32Array(Buffer.from(b, 'base64').buffer.slice(0)));
}
const rms = ch => Math.sqrt(ch.reduce((a, x) => a + x * x, 0) / ch.length);
function diff(a, b) {
  let max = 0, sq = 0, n = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < a[c].length; i++) { const d = Math.abs(a[c][i] - b[c][i]); if (d > max) max = d; sq += d * d; n++; }
  return { max, rms: Math.sqrt(sq / n) };
}

const AUDIO = [
  { name: 'demo, scene B loop', secs: 9 },
  { name: 'demo, whole song', secs: 16, songMode: true },
  { name: 'edge song (v5 import: swing, offsets, chance, slides, mute, lofi kit, crush)', secs: 14, edge: true },
  { name: 'edge, scene E loop with synth muted', secs: 8, edge: true, songMode: false, scene: 4 },
  // MUNCH enabled but without a sample: the four instruments must sound exactly as on the baseline
  { name: 'demo, scene B loop with the MUNCH preview enabled (?munch=dev)', secs: 9, query: '?munch=dev' },
];

// MUNCH (dev preview) on the current build only: it must actually make sound through the offline engine
const MUNCH = { name: 'MUNCH solo: slices + melodic note (current build)', secs: 3, query: '?munch=dev', munch: true };

async function shots(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { let a = 1; Math.random = () => { a = (a * 16807) % 2147483647; return a / 2147483647; }; });
  const page = await ctx.newPage();
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.reload();
  // dismiss the start screen without starting audio, so the LCD's live spectrum stays empty and repeatable
  await page.evaluate(() => document.querySelector('#start').classList.add('hide')); await page.waitForTimeout(400);
  const out = {};
  // the LCD's live spectrum follows real audio (card taps audition a note), so it is masked
  const snap = async k => { await page.waitForTimeout(700); /* let CSS transitions (FX lamps, cards) settle */ out[k] = (await page.screenshot({ mask: [page.locator('#screen')] })).toString('base64'); };
  await snap('jam');
  await page.evaluate(() => window.__harbu.A.setExpanded(true)); await snap('deep edit');
  await page.evaluate(() => window.__harbu.A.setExpanded(false));
  for (let i = 0; i < 4; i++) {
    await page.click(`#cards .card >> nth=${i} >> .card-name`); // the name, not the mute/solo pills await page.evaluate(() => window.__harbu.A.setMode('sound'));
    await snap(`sound, instrument ${i + 1}`);
    await page.evaluate(() => window.__harbu.A.setMode('jam')); await snap(`jam, instrument ${i + 1}`);
  }
  await page.evaluate(() => window.__harbu.A.setMode('arrange')); await snap('arrange');
  out.cards = await page.evaluate(() => document.querySelector('#cards').outerHTML.replace(/ data-(slot|count)="[^"]*"/g, ''));
  await ctx.close();
  return out;
}

(async () => {
  const browser = await chromium.launch();
  console.log('\n— Every instrument slot sounds on its own (current build) —');
  for (let i = 0; i < 4; i++) {
    const out = await render(browser, APP, { name: 'solo', secs: 4, songMode: false, scene: 1, solo: i });
    ok(rms(out[0]) > 1e-3, `instrument ${i + 1} solo renders audio (rms ${rms(out[0]).toFixed(4)})`);
  }
  {
    const out = await render(browser, APP, MUNCH);
    ok(rms(out[0]) > 1e-3, `${MUNCH.name} renders audio (rms ${rms(out[0]).toFixed(4)})`);
  }
  if (!BASE) { console.log('\n(no HARBU_BASELINE_URL: skipping the comparison with a baseline build)'); }
  else {
    console.log(`\n— Offline audio vs baseline (${BASE}) —`);
    for (const scen of AUDIO) {
      const [cur, base] = [await render(browser, APP, scen), await render(browser, BASE, scen)];
      const d = diff(cur, base);
      ok(d.max <= MAX_DIFF && d.rms <= RMS_DIFF && rms(cur[0]) > 1e-3, `${scen.name}: max sample difference ${d.max.toExponential(2)}, rms ${d.rms.toExponential(2)} (signal rms ${rms(cur[0]).toFixed(4)})`);
    }
    console.log('\n— Pixels vs baseline (1180×820, transport stopped) —');
    const [a, b] = [await shots(browser, APP), await shots(browser, BASE)];
    ok(a.cards === b.cards, 'instrument card markup identical (apart from the new data-slot/data-count hooks)');
    const page = await (await browser.newContext()).newPage();
    for (const k of Object.keys(a).filter(k => k !== 'cards')) {
      const n = await page.evaluate(async ([x, y]) => {
        const load = async s => { const bm = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob()); const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext('2d'); g.drawImage(bm, 0, 0); return g.getImageData(0, 0, bm.width, bm.height).data; };
        const [p, q] = [await load(x), await load(y)], w = 1180; let d = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2]) { d++; const X = (i / 4) % w, Y = Math.floor(i / 4 / w); x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y); }
        return d ? `${d} differing pixels in ${x0},${y0} → ${x1},${y1}` : 0;
      }, [a[k], b[k]]);
      ok(n === 0, `${k}: ${n || '0 differing pixels'}`);
    }
  }
  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll baseline checks passed');
  process.exit(failures ? 1 : 0);
})();

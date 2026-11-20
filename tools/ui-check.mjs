// Automated UI checks in headless Chromium (simulated viewports + touch emulation).
// Not a substitute for testing on a real iPad — see docs/TESTING.md.
//
//   npm run dev            (in one terminal)
//   npm run test:ui        (needs Playwright: npx playwright install chromium, or a global install)
//
// Exit code 1 when a check fails.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.error('Playwright not found. Install it with: npm i -D playwright && npx playwright install chromium'); process.exit(2); }

const URL = process.env.HARBU_URL || 'http://localhost:5173/';
const SIZES = [[1024, 768], [1180, 820], [1366, 1024], [1440, 900], [1180, 740], [820, 1180], [768, 1024]];
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failures++; };

async function open(browser, w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click('#startBtn');
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}

/** visible interactive elements that leave the viewport, overlap each other, or are tiny */
async function layoutAudit(page) {
  return page.evaluate(() => {
    const W = innerWidth, H = innerHeight, out = { offscreen: [], small: [], overlaps: [] };
    const els = [...document.querySelectorAll('button, [role=button], .knob, select, canvas#roll')].filter(el => {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (!r.width || !r.height || cs.visibility === 'hidden') return false;
      if (el.closest('.start.hide, [hidden], .menu:not(.open)')) return false;
      if (el.closest('.right') && el.closest('.right').getBoundingClientRect().left >= W) return false; // closed drawer
      // ignore content inside scroll containers that is merely scrolled out of view
      let p = el.parentElement;
      while (p) { const s = getComputedStyle(p).overflowY; if ((s === 'auto' || s === 'scroll') && p.scrollHeight > p.clientHeight) { const pr = p.getBoundingClientRect(); if (r.bottom > pr.bottom || r.top < pr.top) return false; } p = p.parentElement; }
      return true;
    });
    const name = el => (el.getAttribute('aria-label') || el.textContent || el.className || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 28);
    const rects = els.map(el => [el, el.getBoundingClientRect()]);
    rects.forEach(([el, r]) => {
      if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) out.offscreen.push(name(el));
      const tag = el.matches('.knob') ? 40 : 36;
      if ((r.width < tag || r.height < tag) && !el.closest('.snap-x')) out.small.push(`${name(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    });
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const [a, ra] = rects[i], [b, rb] = rects[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ix > 4 && iy > 4) out.overlaps.push(`${name(a)} ↔ ${name(b)}`);
    }
    return out;
  });
}

const state = page => page.evaluate(() => {
  const { store, A } = window.__harbu, p = store.project;
  return { sel: store.ui.sel, scene: p.scene, expanded: store.ui.expanded, transport: A.transport.state, pos: A.transport.position && { ...A.transport.position },
    notes: Object.fromEntries(['bass', 'synth', 'fuzz'].map(t => [t, p.tracks[t].patterns[p.scene].notes.length])),
    kicks: p.tracks.drums.patterns[p.scene].steps.kick.filter(Boolean).length, arrangement: p.arrangement.map(b => `${b.scene}x${b.reps}`), name: p.name, songs: A.library.list().length };
});

async function rollPoint(page, step, rowOrPitch) {
  return page.evaluate(([s, r]) => {
    const cv = document.querySelector('#roll'), b = cv.getBoundingClientRect();
    const { store } = window.__harbu; const drums = store.ui.sel === 'drums';
    const keysW = drums ? (store.ui.coarse ? 96 : 92) : 54, rulerH = store.ui.coarse ? 28 : 24;
    const p = store.project.tracks[store.ui.sel].patterns[store.project.scene];
    const stepW = (b.width - keysW) / (p.len / store.ui.zoom);
    const rowH = drums ? (b.height - rulerH) / 8 : (store.ui.coarse ? 26 : 19);
    return { x: b.left + keysW + (s + .5) * stepW, y: b.top + rulerH + (r + .5) * rowH };
  }, [step, rowOrPitch]);
}

(async () => {
  const browser = await chromium.launch();

  console.log('\n— Layout at representative viewports (simulated) —');
  for (const [w, h] of SIZES) {
    for (const mode of ['jam', 'expanded', 'arrange', 'sound']) {
      const { ctx, page, errors } = await open(browser, w, h);
      if (mode === 'expanded') await page.evaluate(() => window.__harbu.A.setExpanded(true));
      else if (mode !== 'jam') await page.evaluate(m => window.__harbu.A.setMode(m), mode);
      await page.waitForTimeout(250);
      const a = await layoutAudit(page);
      ok(!a.offscreen.length, `${w}×${h} ${mode}: nothing clipped off-screen${a.offscreen.length ? ' — ' + a.offscreen.slice(0, 6).join(', ') : ''}`);
      ok(!a.overlaps.length, `${w}×${h} ${mode}: no overlapping controls${a.overlaps.length ? ' — ' + a.overlaps.slice(0, 4).join('; ') : ''}`);
      if (a.small.length) console.log(`    note: small targets: ${a.small.slice(0, 6).join(', ')}`);
      ok(!errors.length, `${w}×${h} ${mode}: no console errors${errors.length ? ' — ' + errors[0] : ''}`);
      await ctx.close();
    }
  }

  console.log('\n— Interaction flows (1180×820, touch emulation) —');
  const { ctx, page, errors } = await open(browser, 1180, 820);
  await page.evaluate(() => window.__harbu.A.stop());

  // drums: tap a cell to add, tap again to remove
  await page.evaluate(() => window.__harbu.A.selectTrack('drums'));
  const before = (await state(page)).kicks;
  let pt = await rollPoint(page, 1, 0);
  await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(80);
  ok((await state(page)).kicks === before + 1, 'tap on an empty drum cell adds a hit');
  await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(80);
  ok((await state(page)).kicks === before, 'tapping the hit again removes it');

  // melodic: tap empty adds, tap the note removes (no right-click needed)
  await page.evaluate(() => { const { A } = window.__harbu; A.selectTrack('synth'); });
  const n0 = (await state(page)).notes.synth;
  pt = await rollPoint(page, 30, 1);
  await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(80);
  ok((await state(page)).notes.synth === n0 + 1, 'tap on the piano roll adds a note');
  await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(80);
  ok((await state(page)).notes.synth === n0, 'tap on a note removes it');

  // drag a note (mouse path = same pointer events)
  await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(80);
  const moved = await page.evaluate(() => { const { store } = window.__harbu; return store.project.tracks.synth.patterns[store.project.scene].notes.find(n => n.s === 30); });
  await page.mouse.move(pt.x, pt.y); await page.mouse.down(); await page.mouse.move(pt.x - 60, pt.y + 30, { steps: 6 }); await page.mouse.up();
  const after = await page.evaluate(() => { const { store } = window.__harbu; return store.project.tracks.synth.patterns[store.project.scene].notes.filter(n => n.s === 30).length; });
  ok(moved && after === 0, 'dragging a note moves it');

  // undo/redo
  const nBeforeUndo = (await state(page)).notes.synth;
  await page.click('#hUndo'); await page.waitForTimeout(80);
  await page.click('#hRedo'); await page.waitForTimeout(80);
  ok((await state(page)).notes.synth === nBeforeUndo, 'undo then redo returns to the same notes');

  // expand / collapse keeps everything
  await page.click('#play'); await page.waitForTimeout(400);
  const s1 = await state(page);
  await page.click('.btn.tool.expand'); await page.waitForTimeout(200);
  const s2 = await state(page);
  ok(s2.expanded && s2.sel === s1.sel && s2.scene === s1.scene && s2.transport === 'playing' && s2.notes.synth === s1.notes.synth, 'Deep edit keeps instrument, scene, notes and playback');
  ok(await page.isVisible('text=Velocity') && await page.isVisible('text=Chance'), 'Deep edit shows advanced tools');
  await page.click('.btn.tool.expand'); await page.waitForTimeout(200);
  ok(!(await state(page)).expanded && (await state(page)).transport === 'playing', 'back to standard JAM, still playing');

  // transport: pause keeps position, resume continues, stop resets
  await page.click('#play'); await page.waitForTimeout(150);
  const p1 = await state(page);
  await page.waitForTimeout(300);
  const p2 = await state(page);
  ok(p1.transport === 'paused' && p2.pos.step === p1.pos.step, 'pause freezes the musical position');
  await page.click('#play'); await page.waitForTimeout(300);
  const p3 = await state(page);
  ok(p3.transport === 'playing' && p3.pos.step !== 0, 'resume continues from the paused position');
  await page.click('#stop'); await page.waitForTimeout(100);
  ok((await state(page)).transport === 'stopped' && (await state(page)).pos === null, 'stop returns to the beginning');

  // generate on an empty song
  await page.click('#hSong'); await page.click('text=New song…');
  await page.fill('.dlg-input', 'Test song');
  await page.click('.dbtn.primary'); await page.waitForTimeout(200);
  let s = await state(page);
  ok(s.name === 'Test song' && s.songs === 2 && s.notes.synth === 0 && s.kicks === 0 && !s.arrangement.length, 'New Song creates an empty song and keeps the old one');
  await page.evaluate(() => window.__harbu.A.selectTrack('bass'));
  await page.click('.lbtn.big'); await page.waitForTimeout(100);
  ok((await state(page)).notes.bass > 0, 'Generate creates a bass line in the empty song');

  // open the previous song again
  await page.click('#hSong'); await page.click('text=Open…');
  await page.click('.proj:not(.cur) .btn.primary'); await page.waitForTimeout(200);
  ok((await state(page)).name === 'Demo jam', 'Open brings back the previous song');

  // arrange: add, drag to reorder, duplicate, repeat, remove
  await page.click('.mode[data-mode=arrange]'); await page.waitForTimeout(150);
  const arr0 = (await state(page)).arrangement;
  await page.click('.atile >> nth=3'); await page.click('.atile >> nth=3 >> text=Add'); await page.waitForTimeout(100);
  const arr1 = (await state(page)).arrangement;
  ok(arr1.length === arr0.length + 1 && arr1[arr1.length - 1] === '3x1', 'Add puts the scene at the end of the song');
  const blocks = page.locator('#chain .cblock[data-id]');
  await page.waitForTimeout(400); await blocks.nth(0).scrollIntoViewIfNeeded();
  const last = await blocks.nth(arr1.length - 1).boundingBox(), first = await blocks.nth(0).boundingBox();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2); await page.mouse.down();
  await page.mouse.move(first.x + 10, first.y + first.height / 2, { steps: 10 }); await page.mouse.up(); await page.waitForTimeout(150);
  ok((await state(page)).arrangement[0] === '3x1', 'dragging a block reorders the song');
  await blocks.nth(0).click(); await page.waitForTimeout(80);
  if (!(await page.isVisible('.ctxbar'))) { await blocks.nth(0).click(); await page.waitForTimeout(80); }
  await page.click('.ctxbar >> text=Duplicate'); await page.waitForTimeout(80);
  ok((await state(page)).arrangement.length === arr1.length + 1, 'Duplicate adds another instance');
  await page.click('.ctxbar [title="More repeats"]'); await page.waitForTimeout(80);
  ok((await state(page)).arrangement[1] === '3x2', 'repeat count can be raised');
  await page.click('.ctxbar >> text=Remove'); await page.waitForTimeout(80);
  ok((await state(page)).arrangement.length === arr1.length, 'Remove deletes only the instance');
  await page.click('.ctxbar >> text=Move >> nth=1').catch(() => {}); // button fallback for reordering

  // song playback follows arrangement order
  await page.evaluate(() => { const { A, store } = window.__harbu; A.playFromBlock(store.project.arrangement[0].id); });
  await page.waitForTimeout(300);
  const sp = await state(page);
  ok(sp.transport === 'playing' && sp.pos.song && sp.pos.block === 0 && sp.pos.scene === 3, 'Play from here starts the song at that block');
  await page.click('#stop');

  // export downloads a file
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.__harbu.A.exportProject())]);
  ok(/harbumatic-.*\.json$/.test(dl.suggestedFilename()), 'Export produces a .json file');

  ok(!errors.length, `no console errors during flows${errors.length ? ' — ' + errors.join(' | ') : ''}`);
  await ctx.close();
  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll UI checks passed');
  process.exit(failures ? 1 : 0);
})();

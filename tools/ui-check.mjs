// Automated UI checks in headless Chromium (simulated viewports + touch emulation).
// Not a substitute for testing on a real iPad — see docs/TESTING.md.
//
//   npm run dev            (in one terminal)
//   npm run test:ui        (needs Playwright: npx playwright install chromium, or a global install)
//
// Exit code 1 when a check fails.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { VERSION_LABEL, APP_CREDIT } = await import('../src/core/constants.js');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.error('Playwright not found. Install it with: npm i -D playwright && npx playwright install chromium'); process.exit(2); }

const URL = process.env.HARBU_URL || 'http://localhost:5173/';
const SIZES = [[1024, 768], [1180, 820], [1366, 1024], [1440, 900], [1180, 740], [820, 1180], [768, 1024]];
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failures++; };

// five-card layout targets (dev preview ?preview=five): 11" iPad Pro/Air landscape, 13" iPad Pro/Air landscape,
// short landscape (Safari toolbars), the older 10–12.9" sizes above, portrait fallback and desktop
const FIVE_SIZES = [[1194, 834], [1210, 834], [1376, 1032], [1366, 1024], [1180, 820], [1024, 768], [1180, 740], [1024, 700], [820, 1180], [768, 1024], [1440, 900], [1920, 1080]];

async function open(browser, w, h, query = '') {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL + query);
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
      if (a.closest('.mkeys') && b.closest('.mkeys')) continue; // piano keys overlap by design (black over white)
      const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ix > 4 && iy > 4) out.overlaps.push(`${name(a)} ↔ ${name(b)}`);
    }
    // controls that spill out of the card, tile or group that holds them (BUG-002)
    out.spill = [];
    els.forEach(el => {
      const box = el.parentElement && el.parentElement.closest('.card, .atile, .sgroup, .transport, .cblock, .hdr');
      if (!box) return;
      const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
      if (Math.max(b.left - r.left, r.right - b.right, b.top - r.top, r.bottom - b.bottom) > 1) out.spill.push(`${name(el)} in .${box.classList[0]}`);
    });
    return out;
  });
}

/** geometry of the persistent app shell (header + transport/instrument strip) */
const shell = page => page.evaluate(() => ['.hdr', '.brand', '.modes', '.hdr-r', '.strip', '.transport', '#cards', '#ident'].map(s => {
  const r = document.querySelector(s).getBoundingClientRect(); return `${s}:${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`;
}).join(' '));

// slot ids of the four classic instruments (slot-01 … slot-04)
const SLOT = { drums: 'slot-01', bass: 'slot-02', synth: 'slot-03', fuzz: 'slot-04' };
const state = page => page.evaluate(SLOT => {
  const { store, A } = window.__harbu, p = store.project;
  const pt = id => p.slots.find(s => s.id === id).patterns[p.scenes[p.scene].id];
  return { sel: store.ui.sel, scene: p.scene, expanded: store.ui.expanded, transport: A.transport.state, pos: A.transport.position && { ...A.transport.position },
    notes: Object.fromEntries(['bass', 'synth', 'fuzz'].map(t => [t, pt(SLOT[t]).notes.length])),
    kicks: pt(SLOT.drums).steps.kick.filter(Boolean).length, arrangement: p.arrangement.map(b => `${p.scenes.findIndex(s => s.id === b.sceneId)}x${b.reps}`), name: p.name, songs: A.library.list().length };
}, SLOT);

async function rollPoint(page, step, rowOrPitch) {
  return page.evaluate(([s, r]) => {
    const cv = document.querySelector('#roll'), b = cv.getBoundingClientRect();
    const { store } = window.__harbu; const drums = store.ui.sel === 'slot-01';
    const keysW = drums ? (store.ui.coarse ? 96 : 92) : 54, rulerH = store.ui.coarse ? 28 : 24;
    const p = store.project.slots.find(x => x.id === store.ui.sel).patterns[store.project.scenes[store.project.scene].id];
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
      ok(!a.spill.length, `${w}×${h} ${mode}: controls stay inside their card/tile${a.spill.length ? ' — ' + a.spill.slice(0, 4).join('; ') : ''}`);
      if (mode === 'arrange') { // the scene library uses 6 columns once its container is at least 1000 px wide (BUG-002)
        const lib = await page.evaluate(() => { const el = document.querySelector('.arr-scenes'); return { cols: getComputedStyle(el).gridTemplateColumns.split(' ').length, w: document.querySelector('#viewArr').clientWidth }; });
        ok(lib.cols === (lib.w >= 1000 ? 6 : 3), `${w}×${h} arrange: scene library has ${lib.w >= 1000 ? 6 : 3} columns (got ${lib.cols})`);
      }
      if (mode === 'sound') { // labels under segment pickers line up with knob labels in the same row (BUG-002)
        const off = await page.evaluate(() => [...document.querySelectorAll('#viewSound .sgroup .row')].map(row => { const t = [...row.querySelectorAll(':scope > .knob > .klbl, :scope > .wave-pick > .klbl')].map(l => Math.round(l.getBoundingClientRect().top)); return t.length ? Math.max(...t) - Math.min(...t) : 0; }));
        ok(off.every(d => d <= 1), `${w}×${h} sound: control labels share one baseline per row${off.some(d => d > 1) ? ' — off by ' + Math.max(...off) + 'px' : ''}`);
      }
      if (a.small.length) console.log(`    note: small targets: ${a.small.slice(0, 6).join(', ')}`);
      ok(!errors.length, `${w}×${h} ${mode}: no console errors${errors.length ? ' — ' + errors[0] : ''}`);
      await ctx.close();
    }
    // the header and transport/instrument strip must not move or resize when switching modes (BUG-004)
    const { ctx, page } = await open(browser, w, h);
    const geo = {};
    for (const m of ['jam', 'sound', 'arrange', 'jam']) { await page.evaluate(m => window.__harbu.A.setMode(m), m); await page.waitForTimeout(150); geo[m] = geo[m] || await shell(page); }
    ok(geo.jam === geo.sound && geo.jam === geo.arrange, `${w}×${h}: header + strip identical in JAM, SOUND and ARRANGE${geo.jam === geo.arrange ? '' : ' — ' + geo.arrange}`);
    await ctx.close();
  }

  console.log('\n— Five instrument cards (dev preview ?preview=five, simulated) —');
  for (const [w, h] of FIVE_SIZES) {
    const geo = {};
    for (const mode of ['jam', 'expanded', 'sound', 'arrange']) {
      const { ctx, page, errors } = await open(browser, w, h, '?preview=five');
      await page.evaluate(() => window.__harbu.A.stop());
      if (mode === 'expanded') await page.evaluate(() => window.__harbu.A.setExpanded(true));
      else if (mode !== 'jam') await page.evaluate(m => window.__harbu.A.setMode(m), mode);
      await page.waitForTimeout(250);
      const a = await layoutAudit(page);
      const c = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('#cards .card')];
        return {
          list: cards.map(x => `${x.dataset.slot}:${x.dataset.t}`).join(),
          overflowX: document.documentElement.scrollWidth > innerWidth || document.querySelector('.strip').scrollWidth > document.querySelector('.strip').clientWidth,
          pills: cards.flatMap(x => [...x.querySelectorAll('.pill')].map(p => { const r = p.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })),
          clipped: cards.filter(x => { const n = x.querySelector('.card-name'); return n.scrollWidth > n.clientWidth + 1 || n.getBoundingClientRect().right > x.getBoundingClientRect().right; }).map(x => x.dataset.slot),
          cats: cards.map(x => Math.round(x.querySelector('.cat').getBoundingClientRect().width)),
          height: Math.round(document.querySelector('#cards').getBoundingClientRect().height),
        };
      });
      ok(c.list === 'slot-01:drums,slot-02:bass,slot-03:synth,slot-04:fuzz,slot-05:munch', `${w}×${h} ${mode}: five cards in slot order (${c.list})`);
      ok(!c.overflowX, `${w}×${h} ${mode}: no horizontal overflow`);
      ok(!a.offscreen.length && !a.overlaps.length && !a.spill.length, `${w}×${h} ${mode}: nothing clipped, overlapping or spilling out of a card${[...a.offscreen, ...a.overlaps, ...a.spill].length ? ' — ' + [...a.offscreen, ...a.overlaps, ...a.spill].slice(0, 4).join('; ') : ''}`);
      ok(c.pills.every(([pw, ph]) => pw >= 38 && ph >= 36), `${w}×${h} ${mode}: M/S stay touch-sized (min ${Math.min(...c.pills.map(p => p[0]))}×${Math.min(...c.pills.map(p => p[1]))})`);
      ok(!c.clipped.length && c.cats.every(x => x >= 26), `${w}×${h} ${mode}: names readable, every card keeps its character${c.clipped.length ? ' — clipped: ' + c.clipped.join() : ''}`);
      ok(!errors.length, `${w}×${h} ${mode}: no console errors${errors.length ? ' — ' + errors[0] : ''}`);
      if (mode !== 'expanded') geo[mode] = await shell(page);
      if (mode === 'jam') { // the placeholder card is inert: no selection, no audition, no keyboard shortcut
        await page.click('#cards .card[data-slot="slot-05"]', { force: true }).catch(() => {});
        await page.keyboard.press('5'); await page.waitForTimeout(40);
        const st = await page.evaluate(() => ({ sel: window.__harbu.store.ui.sel, ctx: !!window.__harbu.A.engine.ctx && window.__harbu.A.engine.E.ch.has('slot-05') }));
        ok(st.sel === 'slot-01' && !st.ctx, `${w}×${h}: the MUNCH preview card cannot be selected or played`);
      }
      await ctx.close();
    }
    ok(geo.jam === geo.sound && geo.jam === geo.arrange, `${w}×${h} five cards: header + strip identical in JAM, SOUND and ARRANGE${geo.jam === geo.arrange ? '' : ' — ' + geo.arrange}`);
  }
  { // the five-card strip is no taller than the four-card one at the same size (the sequencer keeps its room)
    for (const [w, h] of [[1024, 768], [1180, 820], [1194, 834], [1376, 1032], [1180, 740], [820, 1180]]) {
      const hs = [];
      for (const q of ['', '?preview=five']) { const { ctx, page } = await open(browser, w, h, q); hs.push(await page.evaluate(() => Math.round(document.querySelector('.strip').getBoundingClientRect().height))); await ctx.close(); }
      ok(hs[1] <= hs[0] + 2, `${w}×${h}: strip height with five cards ${hs[1]} px vs four ${hs[0]} px`);
    }
  }

  console.log('\n— Interaction flows (1180×820, touch emulation) —');
  const { ctx, page, errors } = await open(browser, 1180, 820);
  await page.evaluate(() => window.__harbu.A.stop());

  // drums: tap a cell to add, tap again to remove
  await page.evaluate(id => window.__harbu.A.selectSlot(id), SLOT.drums);
  const before = (await state(page)).kicks;
  let pt = await rollPoint(page, 1, 0);
  await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(80);
  ok((await state(page)).kicks === before + 1, 'tap on an empty drum cell adds a hit');
  await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(80);
  ok((await state(page)).kicks === before, 'tapping the hit again removes it');

  // BUG-001: tapping a drum label must never block step editing (stopped and playing, touch and mouse)
  const labelPt = async row => ({ x: await page.evaluate(() => document.querySelector('#roll').getBoundingClientRect().left + 40), y: (await rollPoint(page, 0, row)).y });
  for (const playing of [false, true]) {
    if (playing) await page.evaluate(() => window.__harbu.A.transport.play());
    const lab = await labelPt(0), k0 = (await state(page)).kicks;
    await page.touchscreen.tap(lab.x, lab.y); await page.waitForTimeout(60);
    await page.touchscreen.tap(lab.x, lab.y); await page.waitForTimeout(60);
    ok(await page.evaluate(() => window.__harbu.store.ui.drumRow) === 0, `drum label tap selects the row${playing ? ' (playing)' : ''}`);
    pt = await rollPoint(page, 1, 0);
    await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(60);
    ok((await state(page)).kicks === k0 + 1, `after tapping a drum label, tapping a cell still adds a hit${playing ? ' (playing)' : ''}`);
    await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(60);
    ok((await state(page)).kicks === k0, `…and tapping it again removes it${playing ? ' (playing)' : ''}`);
    await page.mouse.click(lab.x, lab.y); await page.waitForTimeout(60);
    await page.mouse.click(pt.x, pt.y); await page.waitForTimeout(60);
    ok((await state(page)).kicks === k0 + 1, `mouse: label click then cell click adds a hit${playing ? ' (playing)' : ''}`);
    await page.mouse.click(pt.x, pt.y); await page.waitForTimeout(60);
    if (playing) await page.evaluate(() => window.__harbu.A.stop());
  }
  { // drag-painting across a row still works after a label tap
    const lab = await labelPt(0), k0 = (await state(page)).kicks;
    await page.touchscreen.tap(lab.x, lab.y); await page.waitForTimeout(60);
    const a = await rollPoint(page, 1, 0), b = await rollPoint(page, 3, 0);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(60);
    ok((await state(page)).kicks === k0 + 3, 'drag-painting a drum row works after a label tap');
    await page.click('#hUndo'); await page.waitForTimeout(60);
    ok((await state(page)).kicks === k0, 'the paint stroke undoes as one step');
  }

  // BUG-003: dragging a knob rotates only the indicator; the lit cap and its shadow stay put
  {
    const knob = page.locator('#shapers .knob').first(), box = await knob.boundingBox();
    const read = () => knob.evaluate(k => ({ v: k.getAttribute('aria-valuenow'), cap: getComputedStyle(k.querySelector('.cap')).transform, ind: k.querySelector('.ind').style.transform }));
    const k0 = await read();
    await page.mouse.move(box.x + box.width / 2, box.y + 25); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y - 25, { steps: 5 }); await page.mouse.up();
    const k1 = await read();
    ok(k1.v !== k0.v && k1.ind !== k0.ind, 'knob drag changes the value and rotates the indicator');
    ok(k0.cap === 'none' && k1.cap === 'none', 'knob cap (lighting + shadow) never rotates');
    await page.click('#hUndo'); await page.waitForTimeout(60);
  }

  // release identity: one footer line, exact credit, never on top of a control
  {
    const id = await page.evaluate(() => {
      const f = document.querySelector('#ident'), r = f.getBoundingClientRect();
      const hit = [...document.querySelectorAll('button, .knob, canvas#roll, .panel')].filter(e => { const b = e.getBoundingClientRect(); return b.width && Math.min(r.right, b.right) - Math.max(r.left, b.left) > 0 && Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) > 0; });
      return { text: f.textContent, visible: r.width > 0 && r.bottom <= innerHeight, over: hit.length };
    });
    ok(id.text === `HarbuMatic ${VERSION_LABEL} · ${APP_CREDIT}`, `footer shows version and exact credit (${id.text})`);
    ok(id.visible && id.over === 0, 'footer is visible and covers no control');
  }

  // melodic: tap empty adds, tap the note removes (no right-click needed)
  await page.evaluate(id => window.__harbu.A.selectSlot(id), SLOT.synth);
  const n0 = (await state(page)).notes.synth;
  pt = await rollPoint(page, 30, 1);
  await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(80);
  ok((await state(page)).notes.synth === n0 + 1, 'tap on the piano roll adds a note');
  await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(80);
  ok((await state(page)).notes.synth === n0, 'tap on a note removes it');

  // drag a note (mouse path = same pointer events)
  await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(80);
  const synthNotes = () => page.evaluate(id => { const { store } = window.__harbu, p = store.project; return p.slots.find(s => s.id === id).patterns[p.scenes[p.scene].id].notes; }, SLOT.synth);
  const moved = (await synthNotes()).find(n => n.s === 30);
  await page.mouse.move(pt.x, pt.y); await page.mouse.down(); await page.mouse.move(pt.x - 60, pt.y + 30, { steps: 6 }); await page.mouse.up();
  const after = (await synthNotes()).filter(n => n.s === 30).length;
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
  await page.evaluate(id => window.__harbu.A.selectSlot(id), SLOT.bass);
  await page.click('.lbtn.big'); await page.waitForTimeout(100);
  ok((await state(page)).notes.bass > 0, 'Generate creates a bass line in the empty song');

  // open the previous song again
  await page.click('#hSong'); await page.click('text=Open…');
  await page.click('.proj:not(.cur) .btn.primary'); await page.waitForTimeout(200);
  ok((await state(page)).name === 'Demo jam', 'Open brings back the previous song');

  // Settings & help shows the same version and credit
  await page.click('#hSong'); await page.click('text=Settings & help'); await page.waitForTimeout(80);
  ok(await page.isVisible(`.dialog >> text=HarbuMatic ${VERSION_LABEL}`) && await page.isVisible(`.dialog >> text=${APP_CREDIT}`), 'Settings & help shows version and credit');
  await page.click('.dialog .dbtn.primary'); await page.waitForTimeout(80);

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
  { // the exported file is a v6 song with stable slot ids, and importing it again restores it
    const exported = JSON.parse(await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8'));
    ok(exported.v === 6 && exported.slots.map(x => `${x.id}:${x.type}`).join() === 'slot-01:bop,slot-02:goo,slot-03:blip,slot-04:fuzz,slot-05:munch' && !exported.tracks, 'Export writes schema v6 with five slot ids (MUNCH placeholder included)');
    const before = await state(page);
    await page.setInputFiles('#fileIn', { name: 'again.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await page.waitForTimeout(250);
    const again = await state(page);
    ok(again.songs === before.songs + 1 && JSON.stringify(again.arrangement) === JSON.stringify(before.arrangement) && again.kicks === before.kicks, 'importing the exported file restores the song as a new entry');
  }

  // instrument slots: four playable cards with stable slot ids, keyboard 1–4 selects them, no MUNCH card outside the preview
  {
    const cards = await page.evaluate(() => [...document.querySelectorAll('#cards .card')].map(c => `${c.dataset.slot}:${c.dataset.t}:${c.querySelector('.card-name').textContent}`));
    ok(cards.join() === 'slot-01:drums:BOP,slot-02:bass:GOO,slot-03:synth:BLIP,slot-04:fuzz:FUZZ', `cards show BOP, GOO, BLIP, FUZZ in slots 01–04 (${cards.join(' ')})`);
    for (const [k, id] of [['2', 'slot-02'], ['4', 'slot-04'], ['1', 'slot-01']]) { await page.keyboard.press(k); await page.waitForTimeout(40); ok((await state(page)).sel === id, `key ${k} selects ${id}`); }
    await page.keyboard.press('5'); await page.waitForTimeout(40);
    ok((await state(page)).sel === 'slot-01', 'key 5 does nothing while there are four instruments');
    // a song whose MUNCH slot holds data keeps it as it is, but shows only the four playable cards
    const withMunch = await page.evaluate(() => { const p = JSON.parse(JSON.stringify(window.__harbu.store.project)); const m = p.slots.find(x => x.type === 'munch'); m.params.vol = .3; return p; });
    await page.setInputFiles('#fileIn', { name: 'munch.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(withMunch)) });
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({ cards: document.querySelectorAll('#cards .card').length, slots: window.__harbu.store.project.slots.map(x => x.type).join(), vol: window.__harbu.store.project.slots[4].params.vol }));
    ok(after.cards === 4 && after.slots === 'bop,goo,blip,fuzz,munch' && after.vol === .3, 'a stored MUNCH slot is kept as it is but not shown as an instrument');
    // a four-slot v6 file (as Phase 1 wrote it) opens with exactly one MUNCH slot added
    const four = await page.evaluate(() => { const p = JSON.parse(JSON.stringify(window.__harbu.store.project)); p.slots = p.slots.filter(x => x.type !== 'munch'); p.name = 'Four slots'; return p; });
    await page.setInputFiles('#fileIn', { name: 'four.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(four)) });
    await page.waitForTimeout(250);
    const f4 = await page.evaluate(() => ({ name: window.__harbu.store.project.name, slots: window.__harbu.store.project.slots.map(x => `${x.id}:${x.type}`).join(), cards: document.querySelectorAll('#cards .card').length }));
    ok(f4.name === 'Four slots' && f4.slots === 'slot-01:bop,slot-02:goo,slot-03:blip,slot-04:fuzz,slot-05:munch' && f4.cards === 4, `a four-slot v6 song gains one MUNCH slot on import (${f4.slots})`);
    await page.click('#play'); await page.waitForTimeout(300); await page.click('#stop');
  }

  // a v0.5 song file opens through Import with its content intact
  {
    const v5 = (await import('node:fs/promises')).readFile(new globalThis.URL('../tests/fixtures/v5-edge.json', import.meta.url), 'utf8');
    await page.setInputFiles('#fileIn', { name: 'edge.json', mimeType: 'application/json', buffer: Buffer.from(await v5) });
    await page.waitForTimeout(250);
    const e = await page.evaluate(() => { const p = window.__harbu.store.project; return { v: p.v, name: p.name, muted: p.slots.filter(x => x.mute).map(x => x.id).join(), blocks: p.arrangement.map(b => `${b.sceneId}x${b.reps}`).join(), snaps: p.snaps.map(x => (x ? Object.keys(x.slots).length : 0)).join() }; });
    ok(e.v === 6 && e.name === 'Edge case' && e.muted === 'slot-03' && e.blocks === 'scene-05x2,scene-01x1,scene-06x3,scene-05x1' && e.snaps === '4,0,4,0', `v0.5 import keeps mute, arrangement and snapshots (${JSON.stringify(e)})`);
  }

  ok(!errors.length, `no console errors during flows${errors.length ? ' — ' + errors.join(' | ') : ''}`);
  await ctx.close();

  console.log('\n— MUNCH sample engine (dev preview ?munch=dev, fake microphone) —');
  {
    const fs = await import('node:fs/promises');
    const { makeWav } = await import('../tests/helpers/audio.mjs');
    const fixture = f => fs.readFile(new globalThis.URL(`../tests/fixtures/audio/${f}`, import.meta.url));
    // a normal session never shows MUNCH and never opens the sample database
    {
      const { ctx: c0, page: p0 } = await open(browser, 1180, 820);
      const r = await p0.evaluate(async () => ({ cards: document.querySelectorAll('#cards .card').length, dbs: indexedDB.databases ? (await indexedDB.databases()).map(d => d.name) : [] }));
      ok(r.cards === 4 && !r.dbs.includes('harbumatic-samples'), `without ?munch=dev: four cards, no sample storage opened (${r.cards} cards)`);
      await c0.close();
    }
    const mb = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const mopen = async (w, h, extra = {}) => {
      const c = await mb.newContext({ viewport: { width: w, height: h }, hasTouch: true, ...extra });
      const pg = await c.newPage(); const errs = [];
      pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
      await pg.goto(URL + '?munch=dev'); await pg.evaluate(() => localStorage.clear()); await pg.reload(); await pg.click('#startBtn'); await pg.waitForTimeout(250);
      await pg.evaluate(() => window.__harbu.A.stop());
      return { c, pg, errs, H: fn => pg.evaluate(fn) };
    };
    const inView = (pg, sel) => pg.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; }, sel);
    // layout: empty state, PLAY, CHOP, TWIST and JAM at iPad sizes (11" and 13" landscape, short landscape, portrait)
    for (const [w, h] of [[1194, 834], [1210, 834], [1376, 1032], [1366, 1024], [1180, 820], [1024, 768], [1180, 740], [820, 1180], [768, 1024]]) {
      const { c, pg, errs } = await mopen(w, h);
      const landscape = w > h;
      await pg.click('#cards .card[data-slot="slot-05"]', { position: { x: 30, y: 30 } }); await pg.waitForTimeout(200);
      ok((await pg.evaluate(() => window.__harbu.store.ui.mode)) === 'sound', `${w}×${h}: selecting MUNCH opens its SOUND workspace`);
      const rec = await inView(pg, '[data-testid=munch-rec]'), imp = await inView(pg, '[data-testid=munch-import]');
      const scrolled = await pg.evaluate(() => document.querySelector('#viewSound').scrollTop);
      ok(rec && imp && scrolled === 0, `${w}×${h}: RECORD and IMPORT are visible without scrolling`);
      await pg.setInputFiles('[data-testid=munch-file]', { name: 'tone.wav', mimeType: 'audio/wav', buffer: Buffer.from(makeWav({ seconds: 2 })) });
      await pg.waitForSelector('[data-testid=munch-wave]', { timeout: 5000 }).catch(() => {});
      for (const tab of ['play', 'chop', 'twist', 'jam']) {
        if (tab === 'jam') await pg.evaluate(() => window.__harbu.A.setMode('jam'));
        else await pg.click(`[data-testid=munch-tab-${tab}]`);
        await pg.waitForTimeout(180);
        const a = await layoutAudit(pg);
        const over = await pg.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        ok(!over && !a.offscreen.length && !a.overlaps.length && !a.spill.length, `${w}×${h} MUNCH ${tab}: fits, nothing clipped or overlapping${[...a.offscreen, ...a.overlaps, ...a.spill].length ? ' — ' + [...a.offscreen, ...a.overlaps, ...a.spill].slice(0, 4).join('; ') : ''}`);
        if (tab === 'chop' && landscape) {
          const vis = await Promise.all(['[data-testid=munch-chop-here]', '[data-testid=munch-pads] .mw-pad[data-k="7"]', '[data-testid=munch-magic-go]', '[data-testid=munch-grid] .mw-row[data-k="7"] .mw-cell:last-child'].map(sel => inView(pg, sel)));
          ok(vis.every(Boolean), `${w}×${h} CHOP: waveform tools, eight pads, MAGIC CHOP and all eight sequencer rows on screen without scrolling (${vis.join()})`);
        }
        if (tab === 'play') ok(await inView(pg, '[data-testid=munch-keys] .mk:last-child'), `${w}×${h} PLAY: the whole keyboard is on screen`);
      }
      ok(!errs.length, `${w}×${h} MUNCH: no errors${errs.length ? ' — ' + errs[0] : ''}`);
      await c.close();
    }

    const { c: mctx, pg, errs, H } = await mopen(1194, 834, { permissions: ['microphone'] });
    const cards = await H(() => [...document.querySelectorAll('#cards .card')].map(c => c.dataset.slot).join());
    ok(cards === 'slot-01,slot-02,slot-03,slot-04,slot-05', `MUNCH is the fifth playable card (${cards})`);
    const mode = () => H(() => window.__harbu.store.ui.mode);
    // navigation: SOUND by default, explicit choices respected, the other instruments never change mode
    await pg.keyboard.press('5'); await pg.waitForTimeout(80);
    ok((await H(() => window.__harbu.store.ui.sel)) === 'slot-05' && (await mode()) === 'sound', 'key 5 selects MUNCH and opens SOUND');
    await pg.keyboard.press('2'); await pg.waitForTimeout(60);
    ok((await mode()) === 'jam', 'leaving MUNCH returns to JAM (MUNCH had opened SOUND by itself)');
    await pg.keyboard.press('5'); await pg.click('.mode[data-mode=jam]'); await pg.keyboard.press('1'); await pg.keyboard.press('5'); await pg.waitForTimeout(60);
    ok((await mode()) === 'jam', 'after choosing JAM on MUNCH, selecting MUNCH again does not force SOUND');
    await pg.click('.mode[data-mode=sound]'); await pg.keyboard.press('3'); await pg.waitForTimeout(60);
    ok((await mode()) === 'sound', 'choosing SOUND again re-arms it; BLIP then stays in SOUND');
    for (const k of ['1', '2', '4']) { await pg.keyboard.press(k); }
    ok((await mode()) === 'sound', 'BOP, GOO and FUZZ keep the chosen mode');
    await pg.keyboard.press('5'); await pg.waitForTimeout(80);
    // the Lab does not show dead generators for MUNCH
    const lab = await H(() => ({ gen: [...document.querySelectorAll('#rLab .lbtn')].some(b => /Generate/.test(b.textContent)), munch: !!document.querySelector('#rLab [data-testid=lab-munch-chop]') }));
    ok(!lab.gen && lab.munch, 'the Lab hides Generate/Mutate/… for MUNCH and points to MAGIC CHOP');
    ok(await H(() => getComputedStyle(document.querySelector('.bottom')).display === 'none' && document.getElementById('device').classList.contains('munch')), 'the workspace takes the full width (bottom bar and side panel step aside)');
    await pg.click('.mw-drawer'); await pg.waitForTimeout(350);
    ok(await H(() => document.getElementById('device').classList.contains('drawer-open')), 'Scenes & Lab stay reachable as a drawer');
    await H(() => window.__harbu.A.setDrawer(false)); await pg.waitForTimeout(300);

    const status = () => H(() => { const e = document.querySelector('.mw-status'); return e ? e.dataset.status : 'gone'; });
    const toast = () => H(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
    ok((await status()) === 'none' && (await H(() => !!document.querySelector('[data-testid=munch-feed]'))), 'MUNCH starts hungry: the feed panel with RECORD and IMPORT');
    // import: WAV (stereo float), MP3, Ogg/Opus, then a broken file
    const imports = [['stereo.wav', Buffer.from(makeWav({ seconds: 2, rate: 48000, channels: 2, float: true, freq: 330 })), 2], ['tone-c5-1s.mp3', await fixture('tone-c5-1s.mp3'), 1], ['tone-c4-2s.ogg', await fixture('tone-c4-2s.ogg'), 2]];
    for (const [name, buffer, secs] of imports) {
      await pg.setInputFiles('[data-testid=munch-file]', { name, mimeType: 'audio/*', buffer });
      await pg.waitForFunction(n => { const s = window.__harbu.store.project.slots[4].sample; return s && s.name === n && document.querySelector('.mw-status[data-status=ready]'); }, name, { timeout: 8000 }).catch(() => {});
      const r = await H(() => window.__harbu.store.project.slots[4].sample);
      ok(r && r.name === name && Math.abs(r.duration - secs) < .1 && r.slices.length === 9, `import ${name}: ready, ${r && r.duration.toFixed(2)} s, eight slices`);
    }
    ok((await H(() => window.__harbu.store.ui.munch.tab)) === 'play' && (await H(() => !!document.querySelector('[data-testid=munch-keys]'))), 'after the first import MUNCH opens PLAY');
    const before = await H(() => window.__harbu.store.project.slots[4].sample.id);
    await pg.setInputFiles('[data-testid=munch-file]', { name: 'broken.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF....WAVE this is not audio') });
    await pg.waitForTimeout(500);
    ok(/broken\.wav/.test(await toast()) && (await H(() => window.__harbu.store.project.slots[4].sample.id)) === before, 'a broken file is refused with a message and the current sample stays');
    await pg.setInputFiles('[data-testid=munch-file]', { name: 'again.ogg', mimeType: 'audio/ogg', buffer: await fixture('tone-c4-2s.ogg') });
    await pg.waitForTimeout(500);
    const stored = await H(() => window.__harbu.A.samples.store.list().then(l => l.length));
    ok(stored === 3 && (await H(() => window.__harbu.store.project.slots[4].sample.id)) === before, `importing the same file again reuses it (3 stored assets, got ${stored})`);
    const voice = () => H(() => window.__harbu.A.engine.E.ch.get('slot-05').voice);
    const played = () => H(() => window.__harbu.A.engine.E.ch.get('slot-05').voice.stats.played);
    // PLAY: keys audition with velocity; held loop keys sound until released; several keys at once
    const key = midi => pg.locator(`[data-testid=munch-keys] .mk[data-midi="${midi}"]`);
    const press = async (midi, id, frac = .8, type = 'pointerdown') => { const b = await key(midi).boundingBox(); await key(midi).dispatchEvent(type, { pointerId: id, clientX: b.x + b.width / 2, clientY: b.y + b.height * frac, isPrimary: id === 1, pointerType: 'touch' }); };
    let p0 = await played();
    await press(60, 1); await press(60, 1, .8, 'pointerup');
    ok((await played()) === p0 + 1, 'a keyboard key plays the sample');
    await H(() => { const A = window.__harbu.A; A.engine.silenceSustained(); A.setParam('slot-05', 'mode', 'loop'); }); await pg.waitForTimeout(150);
    await press(60, 1, .9); await press(64, 2, .3); await press(67, 3, .6); await pg.waitForTimeout(250);
    const heldN = await H(() => window.__harbu.A.engine.E.ch.get('slot-05').voice.activeCount());
    ok(heldN === 3, `three held loop keys sound together (${heldN} voices)`);
    for (const [m, id] of [[60, 1], [64, 2], [67, 3]]) await press(m, id, .5, 'pointerup');
    await pg.waitForTimeout(400);
    ok((await H(() => window.__harbu.A.engine.E.ch.get('slot-05').voice.activeCount())) === 0, 'releasing the keys ends the looped notes');
    await H(() => window.__harbu.A.setParam('slot-05', 'mode', 'oneshot'));
    // CHOP: pads, waveform cursor, CHOP HERE, drag, delete, undo/redo, slice identity
    await pg.click('[data-testid=munch-tab-chop]'); await pg.waitForTimeout(150);
    p0 = await played();
    await pg.locator('[data-testid=munch-pads] .mw-pad[data-k="3"]').dispatchEvent('pointerdown', { pointerId: 1, isPrimary: true });
    ok((await played()) === p0 + 1 && (await H(() => window.__harbu.store.ui.munch.sel)) === 3 && (await H(() => document.querySelector('.mw-row[data-k="3"]').classList.contains('sel'))), 'a pad plays its slice and selects it in the sequencer too');
    const slices = () => H(() => window.__harbu.store.project.slots[4].sample.slices);
    const wave = async () => (await pg.locator('[data-testid=munch-wave]').boundingBox());
    let wb = await wave();
    await pg.touchscreen.tap(wb.x + wb.width * .3, wb.y + wb.height * .45); await pg.waitForTimeout(100);
    const cur = await H(() => window.__harbu.store.ui.munch.cursor);
    ok(Math.abs(cur - .3) < .02, `tapping the waveform places the cursor (${cur.toFixed(3)})`);
    // a groove on slice 5 (index 4) before chopping
    await pg.click('[data-testid=munch-grid] .mw-row[data-k="4"] .mw-cell[data-s="0"]');
    await pg.click('[data-testid=munch-chop-here]'); await pg.waitForTimeout(120);
    let sl = await slices();
    ok(sl.length === 10 && sl.some(x => Math.abs(x - cur) < 1e-3), `CHOP HERE adds a marker at the cursor (${sl.length - 1} slices)`);
    ok(await H(() => document.querySelector('[data-testid=munch-grid] .mw-row[data-k="5"] .mw-cell[data-s="0"]').getAttribute('aria-pressed') === 'true' && !window.__harbu.store.project.slots[4].patterns[window.__harbu.store.project.scenes[window.__harbu.store.project.scene].id].notes.some(n => n.slice === 4)), 'the groove follows its slice: slice 5 became slice 6, nothing plays the wrong audio');
    // drag the marker at 0.5 (index 5 now) to 0.6 with the mouse, then delete it
    wb = await wave();
    const idx = sl.findIndex(x => Math.abs(x - .5) < 1e-6);
    const hx = wb.x + 6 + (wb.width - 12) * .5, hy = wb.y + wb.height - 6 - 13;
    const cw = await H(() => document.querySelector('[data-testid=munch-wave]').getBoundingClientRect().width);
    const hx2 = wb.x + cw * .5, hx3 = wb.x + cw * .6;
    void hx;
    await pg.mouse.move(hx2, hy); await pg.mouse.down(); await pg.mouse.move(hx2 + 20, hy, { steps: 3 }); await pg.mouse.move(hx3, hy, { steps: 4 }); await pg.mouse.up(); await pg.waitForTimeout(100);
    sl = await slices();
    ok(sl.length === 10 && Math.abs(sl[idx] - .6) < .01, `dragging a marker handle moves the boundary (${sl[idx].toFixed(3)})`);
    ok((await H(() => window.__harbu.store.ui.munch.marker)) === idx, 'the dragged marker is selected');
    await pg.click('[data-testid=munch-nudge-r]');
    ok((await slices())[idx] > sl[idx], 'the nudge button moves the selected marker (alternative to dragging)');
    await pg.click('[data-testid=munch-delete]'); await pg.waitForTimeout(100);
    ok((await slices()).length === 9, 'Delete removes the selected marker');
    await pg.click('#hUndo'); await pg.waitForTimeout(100);
    ok((await slices()).length === 10, 'Undo brings the marker back');
    await pg.click('#hRedo'); await pg.waitForTimeout(100);
    ok((await slices()).length === 9, 'Redo removes it again');
    await pg.click('[data-testid=munch-split]'); await pg.click('[data-testid=munch-reset]'); await pg.waitForTimeout(100);
    ok((await slices()).length === 9, 'Split, then back to eight equal slices');
    // Fit to Beat
    await pg.click('[data-testid=munch-fit] [data-fit="1"]'); await pg.waitForTimeout(80);
    ok((await H(() => window.__harbu.store.project.slots[4].params.fit)) === '1' && /tape ×/.test(await H(() => document.querySelector('.mw-status').textContent)), 'FIT 1 bar is on and the head shows the tape speed');
    await pg.click('[data-testid=munch-fit] [data-fit="4"]'); await pg.waitForTimeout(80);
    ok((await H(() => window.__harbu.store.project.slots[4].params.fit)) === '1' && /too slow/.test(await toast()), 'a fit that is too far for tape is refused with a clear message');
    // MAGIC CHOP: generate, it plays, Undo returns to the pattern, Keep closes
    const patJSON = () => H(() => { const p = window.__harbu.store.project; return JSON.stringify(p.slots[4].patterns[p.scenes[p.scene].id]); });
    const mine = await patJSON();
    await pg.click('[data-testid=munch-magic-go]'); await pg.waitForTimeout(250);
    const gen = await H(() => { const p = window.__harbu.store.project; return p.slots[4].patterns[p.scenes[p.scene].id].notes.filter(n => n.slice != null).length; });
    ok(gen >= 4 && (await H(() => window.__harbu.A.transport.state)) === 'playing', `MAGIC CHOP writes a groove (${gen} hits) and plays it at once`);
    ok(await H(() => !!document.querySelector('[data-testid=munch-magic-undo]')), 'MAGIC CHOP offers Keep and Undo');
    await pg.click('[data-testid=munch-magic-undo]'); await pg.waitForTimeout(100);
    ok((await patJSON()) === mine, 'Undo returns to the pattern from before MAGIC CHOP');
    await pg.click('.mw-style:nth-child(3)'); await pg.waitForTimeout(150);
    await pg.click('[data-testid=munch-magic-keep]'); await pg.waitForTimeout(80);
    ok((await H(() => window.__harbu.store.ui.munch.magic)) === null && (await patJSON()) !== mine, 'a style chip regenerates; Keep keeps it');
    await pg.waitForTimeout(500);
    const st = await voice();
    ok(st.stats.played > p0 + 3 && st.stats.missed === 0, `MUNCH plays through the transport (${st.stats.played - p0} hits, ${st.stats.missed} missed)`);
    await H(() => window.__harbu.A.togglePlay()); await pg.waitForTimeout(100);
    ok((await H(() => [window.__harbu.A.transport.state, window.__harbu.A.engine.E.ch.get('slot-05').voice.activeCount()].join())) === 'paused,0', 'Pause silences every MUNCH voice');
    await H(() => window.__harbu.A.stop());
    // CHOP ↔ JAM: one pattern
    const firstCell = await H(() => { const c = document.querySelector('[data-testid=munch-grid] .mw-cell[aria-pressed=true]'); return c ? `${c.dataset.k}:${c.dataset.s}` : ''; });
    await pg.click('.mode[data-mode=jam]'); await pg.waitForTimeout(150);
    const rr = await pg.evaluate(() => document.querySelector('#roll').getBoundingClientRect());
    await pg.touchscreen.tap(rr.left + 60 + (rr.width - 60) * (13.5 / 16), rr.top + rr.height * .4); await pg.waitForTimeout(100);
    const melodic = await H(() => { const p = window.__harbu.store.project; return p.slots[4].patterns[p.scenes[p.scene].id].notes.filter(n => n.slice == null).length; });
    await pg.click('.mode[data-mode=sound]'); await pg.waitForTimeout(150);
    ok(melodic === 1 && (await H(() => /1/.test(document.querySelector('.mw-melodic')?.textContent || ''))) && (await H(() => { const c = document.querySelector('[data-testid=munch-grid] .mw-cell[aria-pressed=true]'); return c ? `${c.dataset.k}:${c.dataset.s}` : ''; })) === firstCell, 'a note drawn in JAM shows up in CHOP, and CHOP still shows the same slice steps');
    // scenes from the sequencer
    await pg.click('.mw-scene:nth-child(3)'); await pg.waitForTimeout(100);
    ok((await H(() => window.__harbu.store.project.scene)) === 2 && (await H(() => document.querySelectorAll('[data-testid=munch-grid] .mw-cell[aria-pressed=true]').length)) === 0, 'the sequencer switches scenes (scene C is empty)');
    await pg.click('[data-testid=munch-grid] .mw-row[data-k="0"] .mw-cell[data-s="0"]');
    await pg.click('.mw-scene:nth-child(2)'); await pg.waitForTimeout(100);
    ok((await H(() => document.querySelector('[data-testid=munch-grid] .mw-cell[aria-pressed=true]') ? 'x' : '')) === 'x', 'back on scene B its groove is still there');
    // TWIST: the deeper knobs are params; the reversed copy is prepared ahead of playback
    await pg.click('[data-testid=munch-tab-twist]'); await pg.waitForTimeout(120);
    await H(() => { const A = window.__harbu.A; A.setParam('slot-05', 'tune', 7); A.setParam('slot-05', 'start', .2); A.toggleParam('slot-05', 'reverse'); });
    ok((await H(() => { const p = window.__harbu.store.project.slots[4].params; return [p.tune, p.start, p.reverse].join(); })) === '7,0.2,true', 'pitch, trim and reverse are stored as non-destructive params');
    ok(await H(() => !!window.__harbu.A.samples.buffer(window.__harbu.store.project.slots[4].sample.id, true)), 'reverse prepares the reversed copy ahead of playback');
    ok(await H(() => document.querySelectorAll('.mw-twist .knob').length >= 12), 'TWIST shows its knobs');
    // recording from the (fake) microphone: replaces the sound, keeps the groove
    await pg.click('[data-testid=munch-rec]'); await pg.waitForTimeout(1200);
    ok((await H(() => window.__harbu.A.recorder.state)) === 'recording' && (await H(() => document.querySelector('.mw-char')?.dataset.face)) === 'listen', 'recording starts and MUNCH listens');
    await pg.click('[data-testid=munch-rec]');
    await pg.waitForFunction(() => /^Recording/.test(window.__harbu.store.project.slots[4].sample.name), null, { timeout: 5000 }).catch(() => {});
    const rec = await H(() => window.__harbu.store.project.slots[4].sample);
    ok(rec && /^Recording/.test(rec.name) && rec.duration > .5, `a recording becomes the MUNCH sample (${rec && rec.name}, ${rec && rec.duration.toFixed(2)} s)`);
    ok(await H(() => navigator.mediaDevices.enumerateDevices().then(() => window.__harbu.A.recorder.state === 'idle')), 'the microphone is released after recording');
    await pg.click('[data-testid=munch-rec]'); await pg.waitForTimeout(400); await H(() => window.__harbu.A.recordCancel());
    ok((await H(() => [window.__harbu.A.recorder.state, window.__harbu.store.project.slots[4].sample.name].join())) === `idle,${rec.name}`, 'cancelling a recording keeps the current sample');
    // save → reopen: sample, slices, fit and grooves are back
    await H(() => window.__harbu.A.chopAt(.42));
    await H(() => window.__harbu.A.flushSave());
    const snap = await H(() => { const s = window.__harbu.store.project.slots[4]; return JSON.stringify({ sample: s.sample, fit: s.params.fit, pats: s.patterns }); });
    await pg.reload(); await pg.click('#startBtn'); await pg.waitForTimeout(800);
    const back = await H(() => { const s = window.__harbu.store.project.slots[4]; return { j: JSON.stringify({ sample: s.sample, fit: s.params.fit, pats: s.patterns }), st: window.__harbu.A.samples.state(s.sample.id).status }; });
    ok(back.j === snap && back.st === 'ready', `after reload the sample, slices, fit and grooves are back and the audio is ready (${back.st})`);
    const ref = await H(() => window.__harbu.store.project.slots[4].sample);
    await H(() => window.__harbu.A.duplicateProject());
    ok((await H(() => JSON.stringify(window.__harbu.store.project.slots[4].sample))) === JSON.stringify(ref), 'Save a copy keeps the sample reference and slices');
    const [dl] = await Promise.all([pg.waitForEvent('download'), H(() => window.__harbu.A.exportProject())]);
    const exported = JSON.parse(await fs.readFile(await dl.path(), 'utf8'));
    ok(exported.slots[4].sample.id === ref.id && /not portable/.test(await toast()), 'Export keeps the reference and warns that the audio is not included');
    // missing asset: reference kept, clear warning, the feed panel says how to bring it back
    await pg.evaluate(id => window.__harbu.A.samples.store.remove(id), ref.id);
    await H(() => window.__harbu.A.flushSave());
    await pg.reload(); await pg.click('#startBtn'); await pg.waitForTimeout(800);
    await H(() => { window.__harbu.A.stop(); window.__harbu.A.selectSlot('slot-05'); }); await pg.waitForTimeout(200);
    ok((await H(() => window.__harbu.store.project.slots[4].sample.id)) === ref.id && (await H(() => /missing here/.test(document.querySelector('[data-testid=munch-feed]')?.textContent || ''))) && /missing on this device/.test(await toast()), 'a missing sample keeps its reference, warns, and MUNCH asks for the same file');
    await pg.click('#play'); await pg.waitForTimeout(600); await pg.click('#stop');
    ok(!errs.length, `no errors in the MUNCH flows${errs.length ? ' — ' + errs[0] : ''}`);
    await mctx.close();
    // microphone permission denied
    const dctx = await mb.newContext({ viewport: { width: 1180, height: 820 } });
    const dp = await dctx.newPage();
    await dp.goto(URL + '?munch=dev'); await dp.click('#startBtn'); await dp.waitForTimeout(200);
    await dp.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); window.__harbu.A.stop(); window.__harbu.A.selectSlot('slot-05'); });
    await dp.waitForTimeout(150);
    await dp.click('[data-testid=munch-rec]'); await dp.waitForTimeout(300);
    ok(/denied/.test(await dp.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join())) && (await dp.evaluate(() => window.__harbu.A.recorder.state)) === 'idle', 'denied microphone permission gives a clear message');
    await dctx.close();
    await mb.close();
  }

  console.log('\n— Upgrade from a v0.5 library in this browser —');
  {
    const fs = await import('node:fs/promises');
    const edge = await fs.readFile(new globalThis.URL('../tests/fixtures/v5-edge.json', import.meta.url), 'utf8'), id = JSON.parse(edge).id;
    const ctx2 = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
    const page2 = await ctx2.newPage(); const errs = []; page2.on('pageerror', e => errs.push(e.message));
    await page2.goto(URL);
    await page2.evaluate(([edge, id]) => { localStorage.clear(); localStorage.setItem(`harbumatic.v5.song.${id}`, edge); localStorage.setItem('harbumatic.v5.index', JSON.stringify({ current: id, projects: { [id]: { name: 'Edge case', modified: 'x' } } })); }, [edge, id]);
    await page2.reload(); await page2.click('#startBtn'); await page2.waitForTimeout(300);
    await page2.evaluate(() => window.__harbu.A.toggleMute('slot-01')); await page2.evaluate(() => window.__harbu.A.flushSave());
    const r = await page2.evaluate(id => ({ name: window.__harbu.store.project.name, v: window.__harbu.store.project.v, transport: window.__harbu.A.transport.state, v5: localStorage.getItem(`harbumatic.v5.song.${id}`), v6: JSON.parse(localStorage.getItem(`harbumatic.v6.song.${id}`) || 'null') }), id);
    ok(r.name === 'Edge case' && r.v === 6 && r.transport === 'playing', 'the current v0.5 song opens (as v6) and plays');
    ok(r.v5 === edge, 'the v0.5 copy in localStorage is left byte-for-byte untouched (older builds on this origin keep working)');
    ok(r.v6 && r.v6.v === 6 && r.v6.slots[0].mute === true, 'edits are saved to the v6 library');
    ok(!errs.length, `no errors during the upgrade${errs.length ? ' — ' + errs[0] : ''}`);
    await ctx2.close();
  }
  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll UI checks passed');
  process.exit(failures ? 1 : 0);
})();

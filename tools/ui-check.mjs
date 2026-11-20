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
    ok(exported.v === 6 && exported.slots.map(x => x.id).join() === 'slot-01,slot-02,slot-03,slot-04' && !exported.tracks, 'Export writes schema v6 with slot ids');
    const before = await state(page);
    await page.setInputFiles('#fileIn', { name: 'again.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await page.waitForTimeout(250);
    const again = await state(page);
    ok(again.songs === before.songs + 1 && JSON.stringify(again.arrangement) === JSON.stringify(before.arrangement) && again.kicks === before.kicks, 'importing the exported file restores the song as a new entry');
  }

  // instrument slots: four cards with stable slot ids, keyboard 1–4 selects them, no MUNCH card yet
  {
    const cards = await page.evaluate(() => [...document.querySelectorAll('#cards .card')].map(c => `${c.dataset.slot}:${c.dataset.t}:${c.querySelector('.card-name').textContent}`));
    ok(cards.join() === 'slot-01:drums:BOP,slot-02:bass:GOO,slot-03:synth:BLIP,slot-04:fuzz:FUZZ', `cards show BOP, GOO, BLIP, FUZZ in slots 01–04 (${cards.join(' ')})`);
    for (const [k, id] of [['2', 'slot-02'], ['4', 'slot-04'], ['1', 'slot-01']]) { await page.keyboard.press(k); await page.waitForTimeout(40); ok((await state(page)).sel === id, `key ${k} selects ${id}`); }
    await page.keyboard.press('5'); await page.waitForTimeout(40);
    ok((await state(page)).sel === 'slot-01', 'key 5 does nothing while there are four instruments');
    // a song that already holds a MUNCH slot (future sampler) keeps it but shows only the four playable cards
    const withMunch = await page.evaluate(() => { const p = JSON.parse(JSON.stringify(window.__harbu.store.project)); p.slots.push({ id: 'slot-05', type: 'munch', patterns: {} }); return p; });
    await page.setInputFiles('#fileIn', { name: 'munch.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(withMunch)) });
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({ cards: document.querySelectorAll('#cards .card').length, slots: window.__harbu.store.project.slots.map(x => x.type).join() }));
    ok(after.cards === 4 && after.slots === 'bop,goo,blip,fuzz,munch', 'a stored MUNCH slot is kept but not shown as an instrument');
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

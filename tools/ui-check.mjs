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

// five-card layout targets (default ordinary URL): 11" iPad Pro/Air landscape, 13" iPad Pro/Air landscape,
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
      await page.waitForTimeout(mode === 'expanded' ? 400 : 250);
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

  console.log('\n— Five instrument cards (default ordinary URL, simulated) —');
  for (const [w, h] of FIVE_SIZES) {
    const geo = {};
    for (const mode of ['jam', 'expanded', 'sound', 'arrange']) {
      const { ctx, page, errors } = await open(browser, w, h);
      await page.evaluate(() => window.__harbu.A.stop());
      if (mode === 'expanded') await page.evaluate(() => window.__harbu.A.setExpanded(true));
      else if (mode !== 'jam') await page.evaluate(m => window.__harbu.A.setMode(m), mode);
      await page.waitForTimeout(mode === 'expanded' ? 400 : 250);
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
      if (mode === 'jam') { // MUNCH card is active by default: selectable, playable, Mute/Solo work
        await page.click('#cards .card[data-slot="slot-05"] .pill.mute');
        await page.click('#cards .card[data-slot="slot-05"] .pill.solo');
        await page.keyboard.press('5'); await page.waitForTimeout(60);
        const st = await page.evaluate(() => {
          const m = window.__harbu.store.project.slots[4];
          return { sel: window.__harbu.store.ui.sel, mode: window.__harbu.store.ui.mode, mute: m.mute, solo: m.solo, ch: !!window.__harbu.A.engine.ctx && window.__harbu.A.engine.E.ch.has('slot-05') };
        });
        ok(st.sel === 'slot-05' && st.mode === 'sound' && st.mute && st.solo && st.ch, `${w}×${h}: MUNCH card is active by default (sel/sound/mute/solo/channel)`);
      }
      await ctx.close();
    }
    ok(geo.jam === geo.sound && geo.jam === geo.arrange, `${w}×${h} five cards: header + strip identical in JAM, SOUND and ARRANGE${geo.jam === geo.arrange ? '' : ' — ' + geo.arrange}`);
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

  // HBM-061-01: always-visible compact VOL knob right of M and S, aligned on one axis, isolated from card select/audition, synced with SOUND & history
  {
    const align = await page.evaluate(() => [...document.querySelectorAll('#cards .card')].map(c => {
      const m = c.querySelector('.pill.mute').getBoundingClientRect();
      const s = c.querySelector('.pill.solo').getBoundingClientRect();
      const v = c.querySelector('.knob.card-vol').getBoundingClientRect();
      return {
        rightOfMS: v.left >= s.right - 1 && s.left >= m.right - 1,
        dCy: Math.max(Math.abs((v.top + v.height / 2) - (m.top + m.height / 2)), Math.abs((s.top + s.height / 2) - (m.top + m.height / 2))),
        sizeOk: v.width >= 40 && v.height >= 40,
      };
    }));
    ok(align.length === 5 && align.every(a => a.rightOfMS && a.dCy <= 2 && a.sizeOk), `every card has a 40×40+ VOL knob right of M/S on the same vertical axis (${JSON.stringify(align[0])})`);

    // adjust a non-selected card's VOL while playing: no selection change, no audition, audio gain updates, undo/redo + double-tap reset work
    await page.evaluate(() => { window.__harbu.A.selectSlot('slot-01'); window.__harbu.A.togglePlay(); });
    await page.waitForTimeout(120);
    const gooVol = page.locator('#cards .card[data-slot="slot-02"] .knob.card-vol');
    const vb = await gooVol.boundingBox();
    const v0 = await page.evaluate(() => window.__harbu.store.project.slots[1].params.vol);
    await page.evaluate(() => { window.__audCount = 0; const orig = window.__harbu.A.engine.audition; window.__origAud = orig; window.__harbu.A.engine.audition = (...a) => { window.__audCount++; return orig(...a); }; });
    await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
    await page.mouse.down();
    await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2 + 60, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(80);
    const afterDrag = await page.evaluate(() => ({
      sel: window.__harbu.store.ui.sel,
      vol: window.__harbu.store.project.slots[1].params.vol,
      aria: Number(document.querySelector('#cards .card[data-slot="slot-02"] .knob.card-vol').getAttribute('aria-valuenow')),
      aud: window.__audCount,
    }));
    ok(afterDrag.sel === 'slot-01' && afterDrag.aud === 0 && afterDrag.vol < v0 - 0.15 && Math.abs(afterDrag.aria - afterDrag.vol) < 0.02, `dragging non-selected card VOL while playing changes volume without selecting or auditioning (${JSON.stringify(afterDrag)})`);

    // click and Enter on the knob never select the card; ArrowUp adjusts volume
    await gooVol.click();
    await gooVol.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);
    const afterEnter = await page.evaluate(() => ({ sel: window.__harbu.store.ui.sel, aud: window.__audCount }));
    ok(afterEnter.sel === 'slot-01' && afterEnter.aud === 0, 'click and Enter on card VOL knob do not select or audition the card');
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(50);
    const afterArrow = await page.evaluate(() => window.__harbu.store.project.slots[1].params.vol);
    ok(afterArrow > afterDrag.vol && (await page.evaluate(() => window.__harbu.store.ui.sel)) === 'slot-01', 'ArrowUp on focused card VOL knob raises volume without selecting the card');
    await page.evaluate(() => { window.__harbu.A.sealHistory(); window.__harbu.A.engine.audition = window.__origAud; });

    // double-tap resets to instrument registry default (GOO = 0.72)
    await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(70);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(80);
    const afterReset = await page.evaluate(() => ({
      vol: window.__harbu.store.project.slots[1].params.vol,
      aria: Number(document.querySelector('#cards .card[data-slot="slot-02"] .knob.card-vol').getAttribute('aria-valuenow')),
      sel: window.__harbu.store.ui.sel,
    }));
    ok(Math.abs(afterReset.vol - 0.72) < 0.005 && Math.abs(afterReset.aria - 0.72) < 0.02 && afterReset.sel === 'slot-01', `double-tap resets GOO card VOL to registry default 0.72 (${JSON.stringify(afterReset)})`);

    // undo/redo updates card VOL knob
    await page.click('#hUndo'); await page.waitForTimeout(80);
    const afterUndo = await page.evaluate(() => Number(document.querySelector('#cards .card[data-slot="slot-02"] .knob.card-vol').getAttribute('aria-valuenow')));
    await page.click('#hRedo'); await page.waitForTimeout(80);
    const afterRedo = await page.evaluate(() => Number(document.querySelector('#cards .card[data-slot="slot-02"] .knob.card-vol').getAttribute('aria-valuenow')));
    ok(Math.abs(afterUndo - afterArrow) < 0.02 && Math.abs(afterRedo - 0.72) < 0.02, `Undo/Redo synchronizes card VOL knob (${afterUndo} → ${afterRedo})`);

    // sync with SOUND view in both directions without rebuilding the dragged control
    await page.evaluate(() => { window.__harbu.A.stop(); window.__harbu.A.selectSlot('slot-02'); window.__harbu.A.setMode('sound'); });
    await page.waitForTimeout(150);
    const soundVol = page.locator('#viewSound .knob[aria-label="Volume"]');
    const sb = await soundVol.boundingBox();
    await page.evaluate(() => { window.__cardVolNode = document.querySelector('#cards .card[data-slot="slot-02"] .knob.card-vol'); });
    await page.mouse.move(sb.x + sb.width / 2, sb.y + 25); await page.mouse.down(); await page.mouse.move(sb.x + sb.width / 2, sb.y + 85, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(80);
    const syncedFromSound = await page.evaluate(() => ({
      sound: Number(document.querySelector('#viewSound .knob[aria-label="Volume"]').getAttribute('aria-valuenow')),
      card: Number(document.querySelector('#cards .card[data-slot="slot-02"] .knob.card-vol').getAttribute('aria-valuenow')),
      sameNode: window.__cardVolNode === document.querySelector('#cards .card[data-slot="slot-02"] .knob.card-vol'),
    }));
    ok(Math.abs(syncedFromSound.sound - syncedFromSound.card) < 0.02 && syncedFromSound.sameNode, `SOUND Volume drag synchronizes card VOL knob without rebuilding (${JSON.stringify(syncedFromSound)})`);

    // drag card VOL while SOUND is open: SOUND knob updates and card knob node stays intact
    await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2); await page.mouse.down(); await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2 - 55, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(80);
    const syncedToSound = await page.evaluate(() => ({
      sound: Number(document.querySelector('#viewSound .knob[aria-label="Volume"]').getAttribute('aria-valuenow')),
      card: Number(document.querySelector('#cards .card[data-slot="slot-02"] .knob.card-vol').getAttribute('aria-valuenow')),
      sameNode: window.__cardVolNode === document.querySelector('#cards .card[data-slot="slot-02"] .knob.card-vol'),
    }));
    ok(Math.abs(syncedToSound.sound - syncedToSound.card) < 0.02 && syncedToSound.card > syncedFromSound.card + 0.1 && syncedToSound.sameNode, `card VOL drag synchronizes SOUND Volume knob without rebuilding (${JSON.stringify(syncedToSound)})`);

    // save + reload persists volume on the card VOL knob
    await page.evaluate(() => window.__harbu.A.flushSave());
    await page.reload(); await page.click('#startBtn'); await page.waitForTimeout(250);
    await page.evaluate(() => window.__harbu.A.stop());
    const afterReload = await page.evaluate(() => ({
      param: window.__harbu.store.project.slots[1].params.vol,
      card: Number(document.querySelector('#cards .card[data-slot="slot-02"] .knob.card-vol').getAttribute('aria-valuenow')),
    }));
    ok(Math.abs(afterReload.param - syncedToSound.card) < 0.02 && Math.abs(afterReload.card - afterReload.param) < 0.02, `reloading restores saved volume on the card VOL knob (${JSON.stringify(afterReload)})`);

    // restore clean JAM state on slot-01 with original volume
    await page.evaluate(v => { window.__harbu.A.setParam('slot-02', 'vol', v, false); window.__harbu.A.flushSave(); window.__harbu.A.history.clear(); window.__harbu.A.setMode('jam'); window.__harbu.A.selectSlot('slot-01'); }, v0);
    await page.waitForTimeout(120);
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
  const sc0 = await page.evaluate(() => window.__harbu.store.project.scenes.length);
  ok(s.name === 'Test song' && s.songs === 2 && sc0 === 1 && s.notes.synth === 0 && s.kicks === 0 && !s.arrangement.length, 'New Song creates an empty song with one scene and keeps the old one');
  await page.evaluate(id => window.__harbu.A.selectSlot(id), SLOT.bass);
  await page.click('.lbtn.big'); await page.waitForTimeout(100);
  ok((await state(page)).notes.bass > 0, 'Generate creates a bass line in the empty song');

  // dynamic scene library: duplicate independence, new scene, rename, copy to confirm, delete confirm, >6 scenes, undo
  await page.click('#rtabSeg >> text=SCENES'); await page.waitForTimeout(80);
  ok(await page.isDisabled('[data-testid=scene-delete]'), 'cannot delete the final remaining scene');
  const origBass = await page.evaluate(id => JSON.stringify(window.__harbu.store.project.slots.find(x => x.id === id).patterns['scene-01']), SLOT.bass);
  await page.click('[data-testid=scene-dup]'); await page.waitForTimeout(100);
  ok((await page.evaluate(() => window.__harbu.store.project.scenes.length === 2 && window.__harbu.store.project.arrangement.length === 0)), 'Duplicate Scene adds an independent scene without adding it to Song Arrangement');
  await page.evaluate(() => { const { A, store } = window.__harbu; A.clearPattern(); });
  await page.waitForTimeout(80);
  const origAfter = await page.evaluate(id => JSON.stringify(window.__harbu.store.project.slots.find(x => x.id === id).patterns['scene-01']), SLOT.bass);
  ok(origAfter === origBass, 'editing the duplicate never modifies the original scene');
  await page.click('[data-testid=scene-new]'); await page.waitForTimeout(80);
  ok((await page.evaluate(() => window.__harbu.store.project.scenes.length)) === 3, 'New Scene creates an empty scene');
  await page.click('[data-testid=scene-rename]'); await page.fill('.dlg-input', 'Bridge'); await page.click('.dialog .dbtn.primary'); await page.waitForTimeout(80);
  ok((await page.evaluate(() => window.__harbu.store.project.scenes[2].name)) === 'Bridge', 'Rename updates scene name');
  await page.click('[data-testid=scene-delete]'); await page.waitForTimeout(80);
  ok(await page.isVisible('.dialog .dbtn.danger'), 'Delete asks for confirmation');
  await page.click('.dialog .dbtn.danger'); await page.waitForTimeout(80);
  ok((await page.evaluate(() => window.__harbu.store.project.scenes.length)) === 2, 'Confirmed delete removes the scene');
  await page.click('#hUndo'); await page.waitForTimeout(100);
  ok((await page.evaluate(() => window.__harbu.store.project.scenes.length === 3 && window.__harbu.store.project.scenes[2].name === 'Bridge')), 'Undo restores deleted scene');
  await page.click('#rtabSeg >> text=LAB'); await page.waitForTimeout(80);

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

  // export downloads a portable .hbn file
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.__harbu.A.exportProject())]);
  ok(/harbumatic-.*\.hbn$/.test(dl.suggestedFilename()), 'Export produces a .hbn file');
  { // the exported .hbn package carries a v6 project with stable slot ids, and importing it again restores it
    const { parsePackage } = await import('../src/core/package.js');
    const hbnBytes = await (await import('node:fs/promises')).readFile(await dl.path());
    const { project: exported, manifest } = await parsePackage(hbnBytes);
    ok(manifest.format === 'harbumatic-package' && manifest.v === 1 && exported.v === 6 && exported.slots.map(x => `${x.id}:${x.type}`).join() === 'slot-01:bop,slot-02:goo,slot-03:blip,slot-04:fuzz,slot-05:munch' && !exported.tracks, 'Export writes a v1 .hbn package with schema v6 and five slot ids');
    const before = await state(page);
    await page.setInputFiles('#fileIn', { name: 'again.hbn', mimeType: 'application/octet-stream', buffer: hbnBytes });
    await page.waitForTimeout(250);
    const again = await state(page);
    ok(again.songs === before.songs + 1 && JSON.stringify(again.arrangement) === JSON.stringify(before.arrangement) && again.kicks === before.kicks, 'importing the exported .hbn file restores the song as a new entry');
  }

  // instrument slots: five playable cards with stable slot ids, keyboard 1–5 selects them
  {
    const cards = await page.evaluate(() => [...document.querySelectorAll('#cards .card')].map(c => `${c.dataset.slot}:${c.dataset.t}:${c.querySelector('.card-name').textContent}`));
    ok(cards.join() === 'slot-01:drums:BOP,slot-02:bass:GOO,slot-03:synth:BLIP,slot-04:fuzz:FUZZ,slot-05:munch:MUNCH', `cards show BOP, GOO, BLIP, FUZZ, MUNCH in slots 01–05 (${cards.join(' ')})`);
    for (const [k, id] of [['2', 'slot-02'], ['4', 'slot-04'], ['5', 'slot-05'], ['1', 'slot-01']]) { await page.keyboard.press(k); await page.waitForTimeout(40); ok((await state(page)).sel === id, `key ${k} selects ${id}`); }
    // a song whose MUNCH slot holds settings keeps them and shows all five playable cards
    const withMunch = await page.evaluate(() => { const p = JSON.parse(JSON.stringify(window.__harbu.store.project)); const m = p.slots.find(x => x.type === 'munch'); m.params.vol = .3; return p; });
    await page.setInputFiles('#fileIn', { name: 'munch.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(withMunch)) });
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({ cards: document.querySelectorAll('#cards .card').length, slots: window.__harbu.store.project.slots.map(x => x.type).join(), vol: window.__harbu.store.project.slots[4].params.vol, cardVol: Number(document.querySelector('#cards .card[data-slot="slot-05"] .knob.card-vol').getAttribute('aria-valuenow')) }));
    ok(after.cards === 5 && after.slots === 'bop,goo,blip,fuzz,munch' && after.vol === .3 && Math.abs(after.cardVol - .3) < .02, 'a stored MUNCH slot is kept and shown as an active fifth card');
    // a four-slot v6 file (as Phase 1 wrote it) opens with exactly one MUNCH slot added and five cards shown
    const four = await page.evaluate(() => { const p = JSON.parse(JSON.stringify(window.__harbu.store.project)); p.slots = p.slots.filter(x => x.type !== 'munch'); p.name = 'Four slots'; return p; });
    await page.setInputFiles('#fileIn', { name: 'four.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(four)) });
    await page.waitForTimeout(250);
    const f4 = await page.evaluate(() => ({ name: window.__harbu.store.project.name, slots: window.__harbu.store.project.slots.map(x => `${x.id}:${x.type}`).join(), cards: document.querySelectorAll('#cards .card').length }));
    ok(f4.name === 'Four slots' && f4.slots === 'slot-01:bop,slot-02:goo,slot-03:blip,slot-04:fuzz,slot-05:munch' && f4.cards === 5, `a four-slot v6 song gains one active MUNCH slot on import (${f4.slots})`);
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

  console.log('\n— MUNCH sample engine (ordinary URL, fake microphone) —');
  {
    const fs = await import('node:fs/promises');
    const { makeWav } = await import('../tests/helpers/audio.mjs');
    const fixture = f => fs.readFile(new globalThis.URL(`../tests/fixtures/audio/${f}`, import.meta.url));
    // a normal session shows five cards by default and leaves sample storage unopened until a sample is used
    {
      const { ctx: c0, page: p0 } = await open(browser, 1180, 820);
      const r = await p0.evaluate(async () => ({ cards: document.querySelectorAll('#cards .card').length, dbs: indexedDB.databases ? (await indexedDB.databases()).map(d => d.name) : [] }));
      ok(r.cards === 5 && !r.dbs.includes('harbumatic-samples'), `ordinary URL: five cards by default, sample storage idle until used (${r.cards} cards)`);
      await c0.close();
    }
    const mb = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const mopen = async (w, h, extra = {}) => {
      const c = await mb.newContext({ viewport: { width: w, height: h }, hasTouch: true, ...extra });
      const pg = await c.newPage(); const errs = [];
      pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
      await pg.goto(URL); await pg.evaluate(() => localStorage.clear()); await pg.reload(); await pg.click('#startBtn'); await pg.waitForTimeout(250);
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
    ok((await inView(pg, '[data-testid=munch-magic-go]')) && (await inView(pg, '[data-testid=munch-bank-1]')), 'with more than eight slices a second pad bank appears and MAGIC CHOP stays on screen');
    await pg.click('[data-testid=munch-bank-1]'); await pg.waitForTimeout(80);
    ok(await H(() => !!document.querySelector('.mw-pad[data-k="8"]') && !!document.querySelector('.mw-row[data-k="8"]')), 'bank 9–16 shows pad 9 and its sequencer row');
    await pg.click('[data-testid=munch-bank-0]'); await pg.waitForTimeout(80);
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
    await pg.click('[data-testid=munch-split]'); await pg.click('[data-testid=munch-reset]'); await pg.waitForTimeout(120);
    await pg.click('.dbtn.primary'); await pg.waitForTimeout(100); // Equal… asks 4 / 8 / 16 (8 is the default choice)
    ok((await slices()).length === 9, 'Split, then Equal… → back to eight equal slices');
    await pg.click('[data-testid=munch-reset]'); await pg.waitForTimeout(120);
    await pg.click('.dbtn:has-text("16")'); await pg.waitForTimeout(100);
    ok((await slices()).length === 17, 'Equal… can also make sixteen slices (sixteenths of a bar)');
    await pg.click('#hUndo'); await pg.waitForTimeout(100);
    // picking a slice picks its start marker: ◀ ▶ and Delete work without hunting for a handle
    await pg.click('[data-testid=munch-pads] .mw-pad[data-k="3"]'); await pg.waitForTimeout(80);
    const selm = await H(() => ({ sel: window.__harbu.store.ui.munch.marker, dis: document.querySelector('[data-testid=munch-nudge-r]').disabled, info: document.querySelector('.mw-si-t')?.textContent || '' }));
    ok(selm.sel === 3 && !selm.dis && /SLICE 4/.test(selm.info), `tapping pad 4 selects slice 4 and its start marker, so Earlier/Later are ready (${JSON.stringify(selm)})`);
    const startBefore = (await slices())[3];
    await pg.click('[data-testid=munch-nudge-l]'); await pg.waitForTimeout(60);
    ok((await slices())[3] < startBefore, 'Earlier moves the start of the selected slice');
    await pg.click('#hUndo'); await pg.waitForTimeout(80);
    // Fit to Beat
    await pg.click('[data-testid=munch-fit] [data-fit="1"]'); await pg.waitForTimeout(80);
    ok((await H(() => window.__harbu.store.project.slots[4].params.fit)) === '1' && /stretch ×.*pitch kept/.test(await H(() => document.querySelector('.mw-status').textContent)), 'FIT 1 bar is on and the head shows the stretch (pitch kept, the default)');
    await pg.click('[data-testid=munch-fit] [data-fit="4"]'); await pg.waitForTimeout(80);
    ok((await H(() => window.__harbu.store.project.slots[4].params.fit)) === '1' && /too slow/.test(await toast()), 'a fit that is too far is refused with a clear message');
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
    // MUNCH card VOL knob syncs with TWIST Volume and resets to 0.8 on double-tap
    {
      const mv = pg.locator('#cards .card[data-slot="slot-05"] .knob.card-vol'), mb2 = await mv.boundingBox();
      await pg.mouse.move(mb2.x + mb2.width / 2, mb2.y + mb2.height / 2);
      await pg.mouse.down(); await pg.mouse.move(mb2.x + mb2.width / 2, mb2.y + mb2.height / 2 + 55, { steps: 5 }); await pg.mouse.up();
      await pg.waitForTimeout(80);
      const msync = await H(() => ({
        param: window.__harbu.store.project.slots[4].params.vol,
        card: Number(document.querySelector('#cards .card[data-slot="slot-05"] .knob.card-vol').getAttribute('aria-valuenow')),
        twist: Number(document.querySelector('.mw-twist .knob[aria-label="Volume"]').getAttribute('aria-valuenow')),
      }));
      ok(msync.param < 0.7 && Math.abs(msync.card - msync.param) < 0.02 && Math.abs(msync.twist - msync.param) < 0.02, `MUNCH card VOL knob stays in sync with TWIST Volume (${JSON.stringify(msync)})`);
      await pg.mouse.move(mb2.x + mb2.width / 2, mb2.y + mb2.height / 2);
      await pg.mouse.down(); await pg.mouse.up(); await pg.waitForTimeout(70); await pg.mouse.down(); await pg.mouse.up();
      await pg.waitForTimeout(80);
      ok(Math.abs((await H(() => window.__harbu.store.project.slots[4].params.vol)) - 0.8) < 0.005, 'double-tap resets MUNCH card VOL to registry default 0.8');
    }
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
    ok(/\.hbn$/.test(dl.suggestedFilename()), 'MUNCH export produces a portable .hbn package');
    const hbnBuf = await fs.readFile(await dl.path());
    const { parsePackage } = await import('../src/core/package.js');
    const pkg = await parsePackage(hbnBuf);
    ok(pkg.project.slots[4].sample.id === ref.id && pkg.samples.length === 1 && pkg.samples[0].id === ref.id && /with 1 sample/.test(await toast()), 'MUNCH .hbn export embeds the original sample audio');
    // missing asset: reference kept, clear warning, the feed panel says how to bring it back
    await pg.evaluate(id => window.__harbu.A.samples.store.remove(id), ref.id);
    await H(() => window.__harbu.A.flushSave());
    await pg.reload(); await pg.click('#startBtn'); await pg.waitForTimeout(800);
    await H(() => { window.__harbu.A.stop(); window.__harbu.A.selectSlot('slot-05'); }); await pg.waitForTimeout(200);
    ok((await H(() => window.__harbu.store.project.slots[4].sample.id)) === ref.id && (await H(() => /missing here/.test(document.querySelector('[data-testid=munch-feed]')?.textContent || ''))) && /missing on this device/.test(await toast()), 'a missing sample keeps its reference, warns, and MUNCH asks for the same file');
    // exporting while sample is missing aborts cleanly without falling back to JSON
    const failRes = await H(() => window.__harbu.A.exportProject());
    ok(failRes && !failRes.ok && /missing/.test(await toast()), 'Export aborts clearly when a referenced MUNCH sample is missing');
    // importing the portable .hbn restores the deleted sample to ready state
    await pg.setInputFiles('#fileIn', { name: dl.suggestedFilename(), mimeType: 'application/octet-stream', buffer: hbnBuf });
    await pg.waitForTimeout(600);
    ok((await pg.evaluate(id => window.__harbu.A.samples.state(id).status, ref.id)) === 'ready', 'importing the .hbn package restores the embedded sample to ready state');
    await pg.click('#play'); await pg.waitForTimeout(600); await pg.click('#stop');
    ok(!errs.length, `no errors in the MUNCH flows${errs.length ? ' — ' + errs[0] : ''}`);
    await mctx.close();
    // microphone permission denied
    const dctx = await mb.newContext({ viewport: { width: 1180, height: 820 } });
    const dp = await dctx.newPage();
    await dp.goto(URL); await dp.click('#startBtn'); await dp.waitForTimeout(200);
    await dp.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); window.__harbu.A.stop(); window.__harbu.A.selectSlot('slot-05'); });
    await dp.waitForTimeout(150);
    await dp.click('[data-testid=munch-rec]'); await dp.waitForTimeout(300);
    ok(/blocked.*Website Settings.*NotAllowedError/.test(await dp.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join())) && (await dp.evaluate(() => window.__harbu.A.recorder.state)) === 'idle', 'denied microphone permission gives a clear, actionable message with the browser error name');
    await dctx.close();

    console.log('\n— MUNCH v0.6 stabilization (iPad audio session, storage failures, Stretch/Tape, Stop, pads) —');
    // iPad emulation: WebKit's Audio Session API refuses capture while the type is 'playback' (the cause of MUNCH-1)
    {
      const ictx = await mb.newContext({ viewport: { width: 1194, height: 834 }, hasTouch: true, permissions: ['microphone'] });
      await ictx.addInitScript(() => {
        const ses = { type: 'auto' }; navigator.audioSession = ses; window.__sessionLog = [];
        const md = navigator.mediaDevices, gum = md.getUserMedia.bind(md);
        md.getUserMedia = c => { window.__sessionLog.push(ses.type); return ses.type === 'playback' ? Promise.reject(new DOMException('Capture is not allowed in this audio session', 'InvalidStateError')) : gum(c); };
      });
      const ip = await ictx.newPage(); const ierrs = []; ip.on('pageerror', e => ierrs.push(e.message));
      await ip.goto(URL); await ip.evaluate(() => localStorage.clear()); await ip.reload(); await ip.click('#startBtn'); await ip.waitForTimeout(250);
      await ip.evaluate(() => { window.__harbu.A.stop(); window.__harbu.A.selectSlot('slot-05'); }); await ip.waitForTimeout(150);
      ok((await ip.evaluate(() => navigator.audioSession.type)) === 'playback', 'iPad emulation: the engine uses the "playback" audio session (plays through the silent switch)');
      await ip.click('[data-testid=munch-rec]'); await ip.waitForTimeout(700);
      const st = await ip.evaluate(() => ({ rec: window.__harbu.A.recorder.state, ses: navigator.audioSession.type, log: window.__sessionLog.join() }));
      ok(st.rec === 'recording' && st.ses === 'play-and-record' && st.log === 'play-and-record', `iPad emulation: RECORD switches to play-and-record before asking for the microphone and records (${JSON.stringify(st)})`);
      await ip.click('[data-testid=munch-rec]');
      await ip.waitForFunction(() => window.__harbu.store.project.slots[4].sample, null, { timeout: 5000 }).catch(() => {});
      const after = await ip.evaluate(() => ({ s: !!window.__harbu.store.project.slots[4].sample, ses: navigator.audioSession.type, rec: window.__harbu.A.recorder.state, ctx: window.__harbu.A.engine.ctx.state }));
      ok(after.s && after.ses === 'playback' && after.rec === 'idle' && after.ctx === 'running', `iPad emulation: STOP & KEEP gives a sample, restores "playback" and the audio keeps running (${JSON.stringify(after)})`);
      await ip.click('[data-testid=munch-rec]'); await ip.waitForTimeout(500); await ip.click('[data-testid=munch-rec]'); await ip.waitForTimeout(900);
      ok((await ip.evaluate(() => window.__harbu.A.recorder.state + ',' + navigator.audioSession.type)) === 'idle,playback', 'iPad emulation: a second recording works too');
      ok(!ierrs.length, `iPad emulation: no errors${ierrs.length ? ' — ' + ierrs[0] : ''}`);
      await ictx.close();
    }
    // storage: a stale database, a dead connection, and a browser that refuses to store at all
    {
      const sctx = await mb.newContext({ viewport: { width: 1194, height: 834 }, hasTouch: true });
      const sp = await sctx.newPage(); const serrs = []; sp.on('pageerror', e => serrs.push(e.message));
      await sp.goto(URL); await sp.evaluate(() => localStorage.clear());
      await sp.evaluate(() => new Promise(r => { const d = indexedDB.deleteDatabase('harbumatic-samples'); d.onsuccess = d.onerror = () => { const q = indexedDB.open('harbumatic-samples', 1); q.onupgradeneeded = () => q.result.createObjectStore('meta', { keyPath: 'id' }); q.onsuccess = () => { q.result.close(); r(); }; }; }));
      await sp.reload(); await sp.click('#startBtn'); await sp.waitForTimeout(250);
      await sp.evaluate(() => { window.__harbu.A.stop(); window.__harbu.A.selectSlot('slot-05'); }); await sp.waitForTimeout(150);
      await sp.setInputFiles('[data-testid=munch-file]', { name: 'stale.wav', mimeType: 'audio/wav', buffer: Buffer.from(makeWav({ seconds: 1, freq: 300 })) });
      await sp.waitForTimeout(500);
      const stale = await sp.evaluate(async () => { const s = window.__harbu.store.project.slots[4].sample; return { s: !!s, saved: s && await window.__harbu.A.samples.store.has(s.id), unsaved: window.__harbu.A.unsavedSamples().length }; });
      ok(stale.s && stale.saved && !stale.unsaved, `a stale sample database (v1 without its audio store) is repaired by an upgrade and the import is stored (${JSON.stringify(stale)})`);
      await sp.evaluate(() => { const o = IDBDatabase.prototype.transaction; let n = 0; IDBDatabase.prototype.transaction = function (...a) { if (n++ === 0) throw new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError'); return o.apply(this, a); }; });
      await sp.setInputFiles('[data-testid=munch-file]', { name: 'reconnect.wav', mimeType: 'audio/wav', buffer: Buffer.from(makeWav({ seconds: 1, freq: 350 })) });
      await sp.waitForTimeout(500);
      const rc = await sp.evaluate(async () => { const s = window.__harbu.store.project.slots[4].sample; return { name: s.name, saved: await window.__harbu.A.samples.store.has(s.id), reconnects: window.__harbu.A.samples.store.backend.reconnects }; });
      ok(rc.name === 'reconnect.wav' && rc.saved && rc.reconnects >= 1, `a lost storage connection is reopened and the import is stored (${JSON.stringify(rc)})`);
      await sp.evaluate(() => { window.__putFail = true; const o = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...a) { if (window.__putFail) throw new DOMException('simulated', 'UnknownError'); return o.apply(this, a); }; });
      await sp.setInputFiles('[data-testid=munch-file]', { name: 'refused.wav', mimeType: 'audio/wav', buffer: Buffer.from(makeWav({ seconds: 1, freq: 400 })) });
      await sp.waitForTimeout(600);
      const rf = await sp.evaluate(() => ({ name: window.__harbu.store.project.slots[4].sample.name, st: window.__harbu.A.sampleState('slot-05').status, btn: !!document.querySelector('[data-testid=munch-unsaved]'), status: document.querySelector('.mw-status').textContent, toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ') }));
      ok(rf.name === 'refused.wav' && rf.st === 'ready' && rf.btn && /NOT saved/.test(rf.status) && /could not be saved.*UnknownError/.test(rf.toast), `storage refused: the sound still plays, is marked "Not saved" and the toast names the browser error (${rf.status})`);
      await sp.click('[data-testid=munch-unsaved]'); await sp.waitForTimeout(150);
      ok(/UnknownError/.test(await sp.evaluate(() => document.querySelector('[data-testid=munch-storage-diag]')?.textContent || '')), 'the Not saved dialog shows what the browser said');
      await sp.evaluate(() => { window.__putFail = false; });
      await sp.click('.dbtn.primary'); await sp.waitForTimeout(500);
      const ok2 = await sp.evaluate(async () => ({ unsaved: window.__harbu.A.unsavedSamples().length, saved: await window.__harbu.A.samples.store.has(window.__harbu.store.project.slots[4].sample.id), btn: !!document.querySelector('[data-testid=munch-unsaved]') }));
      ok(!ok2.unsaved && ok2.saved && !ok2.btn, `Try again saves it once storage works (${JSON.stringify(ok2)})`);
      await sp.evaluate(() => window.__harbu.A.flushSave());
      await sp.reload(); await sp.click('#startBtn'); await sp.waitForTimeout(800);
      ok((await sp.evaluate(() => window.__harbu.A.samples.state(window.__harbu.store.project.slots[4].sample.id).status)) === 'ready', 'after reload the retried sample is there');
      const rep = await sp.evaluate(async () => { const r = await window.__harbu.A.repairSampleStorage(); return { kept: r.kept, lost: r.lost, ok: await window.__harbu.A.samples.store.has(window.__harbu.store.project.slots[4].sample.id) }; });
      ok(rep.kept >= 3 && rep.lost === 0 && rep.ok, `Repair rescues every readable sample and writes it back (${JSON.stringify(rep)})`);
      ok(!serrs.length, `storage flows: no errors${serrs.length ? ' — ' + serrs[0] : ''}`);
      await sctx.close();
    }
    // Stretch / Tape, Stop while stopped, pads that hold
    {
      const { c: tctx, pg: tp, errs: terrs, H: TH } = await mopen(1194, 834);
      await TH(() => window.__harbu.A.selectSlot('slot-05')); await tp.waitForTimeout(150);
      await tp.setInputFiles('[data-testid=munch-file]', { name: 'loop.wav', mimeType: 'audio/wav', buffer: Buffer.from(makeWav({ seconds: 2, rate: 44100, freq: 220 })) });
      await tp.waitForTimeout(400);
      ok((await TH(() => document.querySelector('[data-testid=munch-fitmode]')?.dataset.fitmode)) === 'stretch', 'Stretch is the default fit mode and visible next to FIT');
      await tp.click('[data-testid=munch-fit] [data-fit="1"]'); // 2 s = 1 bar at 120 BPM; at 100 BPM it stretches ×1.2
      await TH(() => window.__harbu.A.setBpm(100)); await tp.waitForTimeout(100);
      await tp.waitForFunction(() => window.__harbu.A.stretchStatus() === 'ready', null, { timeout: 8000 }).catch(() => {});
      const sv = await TH(() => ({ st: window.__harbu.A.stretchStatus(), mode: window.__harbu.A.samples.stretchMode, text: document.querySelector('.mw-status').textContent }));
      ok(sv.st === 'ready' && sv.mode === 'worker' && /pitch kept/.test(sv.text), `Stretch renders in a Worker and the head says the pitch is kept (${JSON.stringify(sv)})`);
      const rate = await TH(() => { const A = window.__harbu.A; A.engine.init(); const v = A.engine.audition('slot-05', 60, .8); return v && v.rate; });
      ok(rate != null && Math.abs(rate - 1) < .002, `Stretch plays the fitted sound at its own pitch (rate ${rate})`);
      await tp.click('[data-testid=munch-fitmode]'); await tp.waitForTimeout(150);
      const tv = await TH(() => ({ m: window.__harbu.store.project.slots[4].params.fitMode, text: document.querySelector('.mw-status').textContent, rate: window.__harbu.A.engine.audition('slot-05', 60, .8).rate }));
      ok(tv.m === 'tape' && /tape ×/.test(tv.text) && Math.abs(tv.rate - 2 / 2.4) < .001, `TAPE: pitch follows the speed (${JSON.stringify(tv)})`);
      await TH(() => window.__harbu.A.setFitMode('stretch'));
      await TH(() => { window.__harbu.A.stop(); window.__harbu.A.auditionSample(); }); await tp.waitForTimeout(80);
      const n0 = await TH(() => window.__harbu.A.engine.E.ch.get('slot-05').voice.activeCount());
      await TH(() => window.__harbu.A.stop());
      ok(n0 >= 1 && (await TH(() => window.__harbu.A.engine.E.ch.get('slot-05').voice.activeCount())) === 0, 'Stop while stopped ends a long audition');
      await tp.click('[data-testid=munch-tab-chop]'); await tp.waitForTimeout(150);
      await TH(() => { const A = window.__harbu.A; A.checkpoint(); window.__harbu.store.project.slots[4].params.mode = 'gate'; });
      const pad = await tp.$('[data-testid=munch-pads] .mw-pad[data-k="2"]'), box = await pad.boundingBox();
      await tp.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await tp.mouse.down(); await tp.waitForTimeout(150);
      const held = await TH(() => window.__harbu.A.engine.E.ch.get('slot-05').voice.activeCount());
      await tp.mouse.up(); await tp.waitForTimeout(250);
      const rel = await TH(() => window.__harbu.A.engine.E.ch.get('slot-05').voice.activeCount());
      ok(held === 1 && rel === 0, `a pad in Gate mode plays while held and stops on release (${held} → ${rel})`);
      ok(!terrs.length, `Stretch/Stop/pad flows: no errors${terrs.length ? ' — ' + terrs[0] : ''}`);
      await tctx.close();
    }
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
  console.log('\n— HBM-061-04: Responsive SOUND, ARRANGE & Deep Edit toolbar stability —');
  {
    const HBM_SIZES = [[1180, 820], [1194, 834], [1366, 1024], [1180, 740], [1024, 768], [820, 1180], [768, 1024], [640, 900]];
    const NO_SCROLL_LANDSCAPE = new Set(['1180×820', '1194×834', '1366×1024', '1180×740']);
    const SLOTS = ['slot-01', 'slot-02', 'slot-03', 'slot-04', 'slot-05'];

    for (const [w, h] of HBM_SIZES) {
      const tag = `${w}×${h}`;
      const { ctx: c, page: pg, errors: errs } = await open(browser, w, h);
      await pg.evaluate(() => window.__harbu.A.stop());

      // 1. Deep Edit toolbar stability across BOP, GOO, BLIP, FUZZ, MUNCH (including a long scene name)
      await pg.evaluate(() => {
        const { A, store } = window.__harbu;
        store.project.scenes[store.project.scene].name = 'Super Long Breakdown Section';
        A.selectSlot('slot-05'); A.setMode('jam'); A.selectSlot('slot-01'); A.setExpanded(true);
      });
      await pg.waitForTimeout(200);
      const metrics = [];
      for (const sid of SLOTS) {
        await pg.evaluate(id => window.__harbu.A.selectSlot(id), sid);
        await pg.waitForTimeout(80);
        const m = await pg.evaluate(() => {
          const bar = document.querySelector('#jamBar');
          const br = bar.getBoundingClientRect();
          const rect = sel => {
            const el = bar.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
          };
          const instBtns = [...bar.querySelectorAll('.tb-inst button')].map(b => b.dataset.tool || b.textContent.trim() || b.title);
          const allBtns = [...bar.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width > 0);
          const minTouch = Math.min(...allBtns.map(b => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height)));
          return {
            h: Math.round(br.height),
            overflowX: document.documentElement.scrollWidth > innerWidth || bar.scrollWidth > bar.clientWidth + 1,
            minTouch: Math.round(minTouch),
            draw: rect('[data-tool="draw"]'),
            erase: rect('[data-tool="erase"]'),
            vel: rect('[data-tool="vel"]'),
            prob: rect('[data-tool="prob"]'),
            lock: rect('[data-tool="lock"]'),
            bars: rect('.tb-bars'),
            zoom: rect('.tb-zoom'),
            lab: rect('[data-action="lab"]'),
            clear: rect('[data-action="clear"]'),
            done: rect('[data-action="expand"]'),
            instBtns,
          };
        });
        metrics.push({ sid, ...m });
      }
      const ref = metrics[0];
      const stableKeys = ['draw', 'erase', 'vel', 'prob', 'lock', 'bars', 'zoom', 'lab', 'clear', 'done'];
      const drift = [];
      for (const m of metrics.slice(1)) {
        if (Math.abs(m.h - ref.h) > 1) drift.push(`${m.sid}:barH ${ref.h}→${m.h}`);
        for (const k of stableKeys) {
          if (!m[k] || !ref[k] || Math.abs(m[k].x - ref[k].x) > 1 || Math.abs(m[k].y - ref[k].y) > 1) {
            drift.push(`${m.sid}:${k} (${ref[k]?.x},${ref[k]?.y})→(${m[k]?.x},${m[k]?.y})`);
          }
        }
      }
      ok(!drift.length, `${tag} Deep Edit: common controls & Lab/Clear/Done stay locked across all 5 instruments${drift.length ? ' — ' + drift.slice(0, 4).join('; ') : ''}`);
      ok(metrics.every(m => !m.overflowX && m.minTouch >= 36), `${tag} Deep Edit: no horizontal overflow and comfortable touch targets (min ${Math.min(...metrics.map(m => m.minTouch))}px)`);
      ok(metrics[0].instBtns.length === 0 && metrics[1].instBtns.includes('slide') && metrics[2].instBtns.length === 3 && metrics[4].instBtns.length === 3, `${tag} Deep Edit: dedicated instrument zone holds BOP(0), GOO(Slide+melodic), BLIP/MUNCH(melodic)`);

      if (w === 1180 && h === 820) {
        // verify GOO Slide tool and BLIP In key/All notes stability
        await pg.evaluate(() => window.__harbu.A.selectSlot('slot-02')); await pg.waitForTimeout(60);
        await pg.click('#jamBar [data-tool="slide"]'); await pg.waitForTimeout(60);
        ok((await pg.evaluate(() => window.__harbu.store.ui.tool)) === 'slide', 'Deep Edit: GOO Slide tool works in dedicated instrument zone');
        await pg.evaluate(() => window.__harbu.A.selectSlot('slot-03')); await pg.waitForTimeout(60);
        const beforeFold = await pg.evaluate(() => ['[title="Octave up"]', '[data-action="expand"]'].map(s => document.querySelector('#jamBar ' + s)?.getBoundingClientRect().left));
        await pg.click('#jamBar .btn.tool.fold'); await pg.waitForTimeout(60);
        const afterFold = await pg.evaluate(() => ['[title="Octave up"]', '[data-action="expand"]'].map(s => document.querySelector('#jamBar ' + s)?.getBoundingClientRect().left));
        ok(Math.abs(beforeFold[0] - afterFold[0]) <= 1 && Math.abs(beforeFold[1] - afterFold[1]) <= 1, 'Deep Edit: toggling In key ↔ All notes does not shift Oct or Done');
      }

      // 2. SOUND workspace (UX-07) across BOP, GOO, BLIP, FUZZ
      await pg.evaluate(() => window.__harbu.A.setMode('sound'));
      for (const [sid, name] of [['slot-01', 'BOP'], ['slot-02', 'GOO'], ['slot-03', 'BLIP'], ['slot-04', 'FUZZ']]) {
        await pg.evaluate(id => window.__harbu.A.selectSlot(id), sid);
        await pg.waitForTimeout(80);
        const sm = await pg.evaluate(() => {
          const vs = document.querySelector('#viewSound');
          return {
            bottomNone: getComputedStyle(document.querySelector('.bottom')).display === 'none',
            scrollY: vs.scrollHeight > vs.clientHeight + 1,
            overflowX: document.documentElement.scrollWidth > innerWidth || vs.scrollWidth > vs.clientWidth + 1,
            presets: vs.querySelectorAll('.preset').length,
            fxSw: vs.querySelectorAll('.fx-sw').length,
          };
        });
        ok(sm.bottomNone && !sm.overflowX && sm.presets >= 3 && sm.fxSw === 3, `${tag} SOUND ${name}: bottom reclaimed, presets & FX switches visible, no X-overflow`);
        if (NO_SCROLL_LANDSCAPE.has(tag)) ok(!sm.scrollY, `${tag} SOUND ${name}: fits without vertical scrolling`);
      }
      if (w === 1180 && h === 820) {
        await pg.evaluate(() => window.__harbu.A.selectSlot('slot-01')); await pg.waitForTimeout(80);
        await pg.click('#viewSound .fx-sw[data-fx="drive"]'); await pg.waitForTimeout(60);
        ok(await pg.evaluate(() => window.__harbu.store.project.slots[0].params.driveOn === true && document.querySelector('#viewSound .fx-sw[data-fx="drive"]').classList.contains('on')), 'SOUND Channel FX switch toggles Drive and updates state');
        await pg.click('#viewSound .preset >> text=Soft Boom'); await pg.waitForTimeout(60);
        ok(await pg.evaluate(() => window.__harbu.store.project.slots[0].params.driveOn === false && !document.querySelector('#viewSound .fx-sw[data-fx="drive"]').classList.contains('on')), 'SOUND preset updates FX switch state in sync');
      }

      // 3. ARRANGE workspace (UX-08)
      await pg.evaluate(() => window.__harbu.A.setMode('arrange'));
      await pg.waitForTimeout(120);
      const am = await pg.evaluate(() => {
        const va = document.querySelector('#viewArr'), r = va.getBoundingClientRect();
        const tiles = [...va.querySelectorAll('.atile')];
        const allTilesIn = tiles.every(t => { const tr = t.getBoundingClientRect(); return tr.top >= r.top - 1 && tr.bottom <= r.bottom + 1; });
        return {
          bottomNone: getComputedStyle(document.querySelector('.bottom')).display === 'none',
          scrollY: va.scrollHeight > va.clientHeight + 1,
          overflowX: document.documentElement.scrollWidth > innerWidth || va.scrollWidth > va.clientWidth + 1,
          allTilesIn,
          hasActions: ['arr-scene-new', 'arr-scene-dup', 'arr-scene-copy', 'arr-scene-rename', 'arr-scene-delete'].every(id => !!va.querySelector(`[data-testid="${id}"]`)),
        };
      });
      ok(am.bottomNone && !am.overflowX && am.hasActions, `${tag} ARRANGE: bottom reclaimed, all scene actions present, no X-overflow`);
      if (NO_SCROLL_LANDSCAPE.has(tag)) ok(!am.scrollY && am.allTilesIn, `${tag} ARRANGE: Song lane and all 6 scene tiles fit without scrolling`);
      ok(!errs.length, `${tag} HBM-061-04: no console errors${errs.length ? ' — ' + errs[0] : ''}`);
      await c.close();
    }
  }

  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll UI checks passed');
  process.exit(failures ? 1 : 0);
})();

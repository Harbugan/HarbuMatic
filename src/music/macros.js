// Sound Shapers: each friendly macro drives several real synthesis parameters.

export const MACRO_KEYS = ['brightness', 'movement', 'space', 'character'];

export const MACRO_MAP = {
  drums: {
    brightness: (p, v) => { p.tone = v; },
    movement: (p, v, project) => { project.swing = v * .5; },
    space: (p, v) => { p.reverb = v * .35; p.delay = v * .3; },
    character: (p, v) => { p.drive = .1 + v * .9; p.decay = .6 + v * .9; },
  },
  bass: {
    brightness: (p, v) => { p.cutoff = .08 + v * .6; },
    movement: (p, v) => { p.env = .25 + v * .7; p.decay = .12 + v * .6; },
    space: (p, v) => { p.delay = v * .35; p.reverb = v * .3; },
    character: (p, v) => { p.res = .3 + v * .65; p.drive = .2 + v * .7; },
  },
  synth: {
    brightness: (p, v) => { p.cutoff = .2 + v * .75; },
    movement: (p, v) => { p.lfoDepth = Math.max(0, v - .3) * .9; p.lfoRate = .5 + v * 5; },
    space: (p, v) => { p.reverb = v * .6; p.delay = v * .45; p.release = .15 + v * 1.2; },
    character: (p, v) => { p.detune = v * 25; p.mix = .2 + v * .5; },
  },
  fuzz: {
    brightness: (p, v) => { p.tone = v; },
    movement: (p, v) => { p.shimmer = v; },
    space: (p, v) => { p.reverb = .3 + v * .7; p.delay = v * .6; },
    character: (p, v) => { p.crush = v * .8; p.noise = .15 + v * .6; },
  },
};

export const MACRO_HINT = {
  drums: { brightness: 'tone', movement: 'swing', space: 'reverb + delay', character: 'drive + decay' },
  bass: { brightness: 'cutoff', movement: 'env mod + decay', space: 'delay + reverb', character: 'resonance + drive' },
  synth: { brightness: 'cutoff', movement: 'LFO', space: 'reverb + release', character: 'detune + mix' },
  fuzz: { brightness: 'tone', movement: 'shimmer', space: 'reverb + delay', character: 'crush + noise' },
};

/** apply one (or all) macros of a track to its params; mutates the project */
export function applyMacros(project, track, key) {
  const tr = project.tracks[track];
  (key ? [key] : MACRO_KEYS).forEach(k => MACRO_MAP[track][k](tr.params, tr.macros[k], project));
}

// Waveform peak data for the MUNCH editor: computed once per decoded buffer (in the bank), never per frame.
// Pure functions over anything shaped like an AudioBuffer ({ numberOfChannels, length, sampleRate, getChannelData }).
//
//   peaks = { bucket, frames, sampleRate, min: Float32Array, max: Float32Array }
//   one min/max pair per `bucket` frames, over all channels (so stereo shows its full extent)
//
// 30 s at 48 kHz with 64-frame buckets = 22 500 pairs (180 kB): fine-grained enough for 16× zoom on a 1366 px wide
// screen, small enough to aggregate to pixel columns on every redraw.

export const PEAK_BUCKET = 64;

export function computePeaks(buffer, bucket = PEAK_BUCKET) {
  const frames = buffer.length, n = Math.max(1, Math.ceil(frames / bucket));
  const min = new Float32Array(n), max = new Float32Array(n);
  min.fill(1); max.fill(-1);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) {
      const b = (i / bucket) | 0, x = d[i];
      if (x < min[b]) min[b] = x;
      if (x > max[b]) max[b] = x;
    }
  }
  for (let b = 0; b < n; b++) if (min[b] > max[b]) { min[b] = 0; max[b] = 0; }
  return { bucket, frames, sampleRate: buffer.sampleRate, min, max };
}

/**
 * Aggregate peaks to `columns` pixel columns covering the fraction range [a, b] of the sample.
 * Returns { min, max } Float32Arrays of length `columns` (silence = 0, 0).
 */
export function peaksForView(peaks, a, b, columns) {
  const cols = Math.max(1, Math.floor(columns)), min = new Float32Array(cols), max = new Float32Array(cols);
  if (!peaks || !peaks.min.length || !(b > a)) return { min, max };
  const n = peaks.min.length;
  for (let x = 0; x < cols; x++) {
    const f0 = a + (b - a) * (x / cols), f1 = a + (b - a) * ((x + 1) / cols);
    let i0 = Math.floor(f0 * n), i1 = Math.max(i0 + 1, Math.ceil(f1 * n));
    i0 = Math.max(0, Math.min(n - 1, i0)); i1 = Math.max(i0 + 1, Math.min(n, i1));
    let lo = 1, hi = -1;
    for (let i = i0; i < i1; i++) { if (peaks.min[i] < lo) lo = peaks.min[i]; if (peaks.max[i] > hi) hi = peaks.max[i]; }
    if (lo > hi) { lo = 0; hi = 0; }
    min[x] = lo; max[x] = hi;
  }
  return { min, max };
}

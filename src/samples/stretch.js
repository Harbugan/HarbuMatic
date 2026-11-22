// Pitch-preserving time-stretch for MUNCH's Stretch fit mode: WSOLA (waveform-similarity overlap-add), anchored at
// slice boundaries. Pure maths on Float32Arrays (no Web Audio), so it runs in Node tests, in a Worker and on the main
// thread alike.
//
//   stretchChannels([left, right], sampleRate, factor, { anchors })  →  [left', right']   (length ≈ input × factor)
//
// How it works
//   The input is cut into overlapping frames (~32 ms, Hann window, ~50 % overlap) that are laid down at the output
//   hop. Each frame is read from the input near its nominal position (output position / factor); within ±8 ms the
//   position whose start best matches the natural continuation of the previous frame (normalised cross-correlation on
//   the mono mix) wins, so the overlap adds waveforms that are in phase: the pitch stays, the duration changes.
//   Every channel uses the same positions, so the stereo image is kept.
// Anchors (slice boundaries) make it musical for chopped material:
//   - every segment between two anchors is stretched on its own and lands at exactly round(anchor × factor), so
//     slice positions scale exactly and the timing never drifts
//   - the first frame of a segment is copied verbatim from the anchor (flat window start): every slice's attack is
//     preserved sample for sample instead of being smeared or doubled
//   - a segment never reads audio past its end (no pre-echo of the next hit), and its last 5 ms blend into the
//     original audio leading into the next anchor, so consecutive segments join without a step
// Cost: O(output × search / 8) — a 2 s stereo break takes a few ms, the 30 s worst case a fraction of a second; the
// app runs it in a Worker (src/samples/stretch-runner.js).

const FRAME_SEC = .032, SEARCH_SEC = .008, JOIN_SEC = .005;

const evenFloor = x => Math.max(0, Math.floor(x / 2) * 2);

/** anchor positions (input sample indices) from slice boundaries (fractions of the sample) */
export function anchorsFromSlices(slices, length) {
  const xs = [0, length];
  for (const f of Array.isArray(slices) ? slices : []) if (typeof f === 'number' && Number.isFinite(f)) xs.push(Math.round(Math.min(1, Math.max(0, f)) * length));
  return [...new Set(xs)].sort((a, b) => a - b);
}

/**
 * Generator form (yields between frames so a caller can time-slice it); returns the output channels.
 * @param channels  Float32Array[] (same length)
 * @param factor    output duration / input duration (2 = twice as long, same pitch)
 * @param anchors   sorted input sample indices that must map exactly (0 and length are added)
 */
export function* stretchGen(channels, sampleRate, factor, { anchors = [], frameSec = FRAME_SEC, searchSec = SEARCH_SEC, yieldEvery = 64 } = {}) {
  const C = channels.length, inLen = C ? channels[0].length : 0;
  const outLen = Math.max(0, Math.round(inLen * factor));
  const out = Array.from({ length: C }, () => new Float32Array(outLen));
  if (!inLen || !outLen) return out;
  if (Math.abs(factor - 1) < 1e-9) { channels.forEach((ch, c) => out[c].set(ch.subarray(0, outLen))); return out; }
  // mono mix + prefix energy for the similarity search
  const mono = new Float32Array(inLen);
  for (let c = 0; c < C; c++) { const ch = channels[c]; for (let i = 0; i < inLen; i++) mono[i] += ch[i] / C; }
  const energy = new Float64Array(inLen + 1);
  for (let i = 0; i < inLen; i++) energy[i + 1] = energy[i] + mono[i] * mono[i];
  const acc = Array.from({ length: C }, () => new Float32Array(outLen)), wsum = new Float32Array(outLen);
  const pts = [...new Set([0, inLen, ...anchors.filter(a => Number.isFinite(a) && a > 0 && a < inLen).map(Math.round)])].sort((a, b) => a - b);
  const N0 = Math.max(16, evenFloor(sampleRate * frameSec)), D0 = Math.max(1, Math.round(sampleRate * searchSec));
  let frames = 0;
  const joins = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1], A = Math.round(a * factor), B = k === pts.length - 2 ? outLen : Math.round(b * factor);
    const segLen = b - a, span = B - A;
    if (span <= 0) continue;
    const N = Math.min(N0, evenFloor(segLen), evenFloor(span));
    if (N < 16) { // a sliver: plain linear resampling is inaudible at this size
      for (let n = 0; n < span; n++) {
        const x = a + (span > 1 ? n * (segLen - 1) / (span - 1) : 0), i = Math.floor(x), f = x - i, j = Math.min(b - 1, i + 1);
        for (let c = 0; c < C; c++) { acc[c][A + n] += channels[c][i] * (1 - f) + channels[c][j] * f; }
        wsum[A + n] += 1;
      }
      continue;
    }
    const hop = N / 2, D = Math.min(D0, N / 2), joinX = k < pts.length - 2 ? Math.min(Math.round(sampleRate * JOIN_SEC), N / 2, span) : 0;
    let prevIn = a, prevOut = A;
    for (let j = 0, outPos = A; outPos < B; j++, outPos = A + j * hop) {
      let inPos;
      if (j === 0) inPos = a; // the attack: copied verbatim
      else {
        const nominal = Math.round(a + (outPos - A) / factor), h = outPos - prevOut, L = N - h;
        const centre = Math.max(a, Math.min(b - N, nominal)); // never read past the segment end
        const lo = Math.max(a, centre - D), hi = Math.min(b - N, centre + D);
        const ref = prevIn + h; // natural continuation of the previous frame
        if (hi <= lo || L < 8 || ref + L > inLen) inPos = centre;
        else {
          const sim = (r, pos, len, stride) => { let s = 0; for (let i = 0; i < len; i += stride) s += mono[r + i] * mono[pos + i]; const e = energy[pos + len] - energy[pos]; return e > 1e-12 ? s / Math.sqrt(e) : 0; };
          // a frame that reaches the join should also be in phase with the original audio it blends into there
          const jo = joinX && outPos + N > B - joinX ? B - joinX - outPos : null;
          const corr = (pos, stride) => sim(ref, pos, L, stride) + (jo != null && jo >= 0 ? sim(b - joinX, pos + jo, joinX, stride) : 0);
          let best = centre, bv = -Infinity;
          for (let p = lo; p <= hi; p += 4) { const v = corr(p, 8); if (v > bv) { bv = v; best = p; } }
          const c0 = best; bv = -Infinity;
          for (let p = Math.max(lo, c0 - 3); p <= Math.min(hi, c0 + 3); p++) { const v = corr(p, 2); if (v > bv) { bv = v; best = p; } }
          inPos = best;
        }
      }
      // Hann window; the segment's first frame has a flat first half, so the attack is exact
      for (let n = 0; n < N; n++) {
        const o = outPos + n; if (o >= B) break;
        const w = j === 0 && n < N / 2 ? 1 : .5 - .5 * Math.cos(2 * Math.PI * n / N);
        for (let c = 0; c < C; c++) acc[c][o] += channels[c][inPos + n] * w;
        wsum[o] += w;
      }
      prevIn = inPos; prevOut = outPos;
      if (++frames % yieldEvery === 0) yield frames;
    }
    if (joinX) joins.push([B, b, joinX]);
  }
  for (let o = 0; o < outLen; o++) { const w = wsum[o]; if (w > 1e-6) for (let c = 0; c < C; c++) out[c][o] = acc[c][o] / w; }
  // joins: the last few ms before each anchor blend into the original audio that leads into it, so the next
  // segment (which starts with the anchor's own samples) follows without a step
  for (const [B, b, X] of joins) {
    for (let i = 0; i < X; i++) {
      const o = B - X + i, x = b - X + i; if (o < 0 || x < 0) continue;
      const r = .5 - .5 * Math.cos(Math.PI * (i + 1) / (X + 1));
      for (let c = 0; c < C; c++) out[c][o] = out[c][o] * (1 - r) + channels[c][x] * r;
    }
  }
  return out;
}

/** synchronous stretch (tests, Worker) */
export function stretchChannels(channels, sampleRate, factor, opts = {}) {
  const g = stretchGen(channels, sampleRate, factor, { ...opts, yieldEvery: Infinity });
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

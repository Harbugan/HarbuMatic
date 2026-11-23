// Audio Session API (WebKit: Safari and every browser on iPadOS/iOS 17+).
//
// HarbuMatic sets the session type to 'playback' so it plays even with the ring/silent switch on. WebKit refuses
// microphone capture while the type is 'playback' (or 'ambient'/'transient'): getUserMedia rejects with
// InvalidStateError at once, before any permission prompt. That was the cause of "The microphone could not be
// started" on iPad (BUGS.md, MUNCH-1). So the type is switched to 'play-and-record' only while the microphone is
// open, and back to what it was afterwards.
//
// Browsers without navigator.audioSession (Chromium, Firefox, older Safari) make every call a no-op.

/** @param getNav () → navigator-like object (replaceable in tests) */
export function createAudioSession(getNav = () => globalThis.navigator) {
  const api = () => { const n = getNav(); return n && n.audioSession ? n.audioSession : null; };
  const set = t => {
    const a = api(); if (!a) return false;
    try { a.type = t; } catch (e) { return false; }
    return a.type === t;
  };
  let before = null; // type to restore after capture
  return {
    get supported() { return !!api(); },
    get type() { const a = api(); return a ? a.type : null; },
    /** normal state: play through the silent switch */
    playback() { before = null; return set('playback'); },
    /** allow capture (call synchronously before getUserMedia, inside the tap); true when capture is allowed */
    capture() {
      const a = api(); if (!a) return true;
      if (a.type === 'play-and-record' || a.type === 'auto') return true;
      before = a.type;
      return set('play-and-record') || set('auto');
    },
    /** capture ended: back to the type from before capture() */
    release() {
      const a = api(); if (!a || before == null) return;
      const t = before; before = null;
      set(t);
    },
  };
}

/** session types under which WebKit allows microphone capture */
export const captureAllowed = type => type == null || type === 'auto' || type === 'play-and-record';

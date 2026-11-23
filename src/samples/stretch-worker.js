// Worker side of src/samples/stretch-runner.js: one render per message, results transferred back.
import { stretchChannels } from './stretch.js';

self.onmessage = e => {
  const { id, channels, sampleRate, factor, anchors } = e.data;
  try {
    const out = stretchChannels(channels, sampleRate, factor, { anchors });
    self.postMessage({ id, channels: out }, out.map(c => c.buffer));
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};

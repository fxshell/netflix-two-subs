/* Shared, local transcript alignment. Netflix translations have different cue breaks. */
(() => {
  'use strict';
  function align(primary, secondary) {
    const rows = primary.map(c => ({ start: c.start, end: c.end, primary: c.text, secondary: '' }));
    let first = 0;
    for (const cue of secondary) {
      while (first < primary.length && primary[first].end <= cue.start) first++;
      let best = -1, score = 0;
      for (let i = first; i < primary.length && primary[i].start < cue.end; i++) {
        const overlap = Math.min(primary[i].end, cue.end) - Math.max(primary[i].start, cue.start);
        if (overlap > score) { score = overlap; best = i; }
      }
      if (best >= 0) {
        const row = rows[best];
        row.secondary += (row.secondary ? '\n' : '') + cue.text;
        row.start = Math.min(row.start, cue.start);
        row.end = Math.max(row.end, cue.end);
      } else rows.push({ start: cue.start, end: cue.end, primary: '', secondary: cue.text });
    }
    return rows.sort((a, b) => a.start - b.start);
  }
  function timestamp(seconds) {
    const n = Math.max(0, Math.floor(seconds));
    return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60]
      .map((v, i) => i ? String(v).padStart(2, '0') : String(v)).join(':');
  }
  globalThis.N2STranscript = { align, timestamp };
})();

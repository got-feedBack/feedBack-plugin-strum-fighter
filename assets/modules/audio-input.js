// Strum Fighter — guitar input via the desktop audio engine bridge.
//
// Two jobs:
//   1) Strum-onset detection — poll audio.getLevels() on a ~60 Hz loop and
//      fire onStrum() on a debounced rising edge of the input level.
//   2) Chord scoring — audio.scoreChord({ notes, ... }) scores the CURRENT
//      live audio against a target chord shape, chart-free. Returns
//      { isHit, score, hitStrings, totalStrings, results[] } (or null on a
//      downlevel addon / browser-only build).
//
// The whole mechanic needs the JUCE engine (slopsmith-desktop). hasEngine()
// lets the game show a graceful "needs desktop" panel otherwise.

function bridge() {
  // Back-compat: the host renamed window.slopsmithDesktop → window.feedBackDesktop
  // (got-feedback/feedBack-desktop#40). Fall back to the legacy name so the game
  // detects the engine on desktop builds that still expose the old bridge.
  const host = (typeof window !== 'undefined' && (window.feedBackDesktop || window.slopsmithDesktop)) || null;
  return (host && host.audio) || null;
}

export function hasEngine() {
  const a = bridge();
  return !!(a && typeof a.scoreChord === 'function' && typeof a.getLevels === 'function');
}

export function createAudioInput({ onStrum, onLevel } = {}) {
  const audio = bridge();
  let running = false;
  let timer = null;
  let level = 0;
  let baseline = 0;     // rolling estimate of the steady background level
  let prevLevel = 0;    // previous frame's level (for the fast-attack test)
  let primed = false;   // warm-start the baseline on the first frame
  let armed = true;     // true = ready to fire; false = waiting to re-arm
  let lastOnsetAt = 0;
  let opts = { pitchCheckCents: 55, minHitRatio: 0.5, harmonicSnr: 3.0, fundamentalRatio: 0.20 };

  // Onset tuning — RELATIVE to a rolling background, not an absolute floor.
  // A strum is a sharp rise ABOVE the current background (steady amp hiss, a
  // noisy pickup, or — the bug this fixes — the boss wave's continuous backing
  // music, which used to pin the level above a fixed floor so the old detector
  // never saw "quiet" and dropped every strum).
  //   ABS_FLOOR  — a strum must reach at least this, period (dead-silence guard)
  //   RISE_RATIO — …and be this many times the background, OR
  //   RISE_DELTA — …at least this far above it (handles a near-zero background)
  //   REARM_DELTA— after firing, the level must fall back to within this of the
  //                background before another strum can fire (debounces ring-out)
  //   BASE_ATTACK/RELEASE — how fast the background tracker rises/falls. Slow
  //                attack so a strum transient barely moves it; quicker release
  //                so the floor drops when the music stops.
  const ABS_FLOOR = 0.05;
  const RISE_RATIO = 1.6;
  const RISE_DELTA = 0.06;
  const REARM_DELTA = 0.04;
  const SLOPE = 0.03;          // a strum jumps fast frame-to-frame; slow music
                               // swells (e.g. the boss track fading in) do not
  const BASE_ATTACK = 0.012;
  const BASE_RELEASE = 0.06;
  const MIN_GAP_MS = 170;

  async function tick() {
    if (!running) return;
    try {
      const lv = await audio.getLevels();
      // Number.isFinite (not typeof === 'number') — a NaN reading would be
      // sticky: baseline += (NaN - baseline) poisons the EMA permanently and
      // kills onset detection for the rest of the run.
      const il = (lv && Number.isFinite(lv.inputLevel)) ? lv.inputLevel : 0;
      level = il;
      if (onLevel) onLevel(il);

      const now = performance.now();

      // Warm-start: seed the background to the first reading so a cold 0→floor
      // jump isn't mistaken for a strum.
      if (!primed) { primed = true; baseline = il; prevLevel = il; timer = setTimeout(tick, 16); return; }

      // Track the steady background (slow EMA — transients barely move it).
      baseline += (il - baseline) * (il > baseline ? BASE_ATTACK : BASE_RELEASE);

      // Fire when the level jumps clearly ABOVE the background AND rises fast
      // (a pluck attack, not a slow music swell); re-arm once it falls back near
      // the background. Immune to a high-but-steady floor (boss music) that the
      // old absolute-quiet gate could never see past.
      const onsetThresh = Math.max(ABS_FLOOR, baseline + RISE_DELTA, baseline * RISE_RATIO);
      const rearmThresh = baseline + REARM_DELTA;

      if (!armed) {
        if (il < rearmThresh) armed = true;
      } else if (il > onsetThresh && il - prevLevel > SLOPE && now - lastOnsetAt > MIN_GAP_MS) {
        lastOnsetAt = now;
        armed = false;
        console.debug('[strum_fighter] onset lvl=' + il.toFixed(3) + ' base=' + baseline.toFixed(3));
        if (onStrum) onStrum();
      }
      prevLevel = il;
    } catch (_e) {
      // transient IPC hiccup — keep polling
    }
    timer = setTimeout(tick, 16);
  }

  return {
    start() { if (!running) { running = true; tick(); } },
    stop() {
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      // Reset the detector so a future start() on this instance begins from a
      // clean baseline rather than the previous session's background estimate.
      baseline = 0; prevLevel = 0; primed = false; armed = true;
    },
    getLevel() { return level; },
    setScoreOpts(o) { opts = Object.assign({}, opts, o); },
    // Score the current live audio against a target chord (array of {s,f}).
    async score(notes) {
      if (!audio || typeof audio.scoreChord !== 'function' || !notes || !notes.length) return null;
      try {
        // Match note_detect's chord-scoring mode: the DSP harmonic-comb
        // verifier (bypassMl + harmonicVerify), which actually detects
        // strummed chords — the plain energy/band check returns ~0/N.
        return await audio.scoreChord({
          arrangement: 'guitar',
          stringCount: 6,
          offsets: [0, 0, 0, 0, 0, 0],
          capo: 0,
          pitchCheckCents: opts.pitchCheckCents,
          minHitRatio: opts.minHitRatio,
          bypassMl: true,
          harmonicVerify: true,
          harmonicSnr: opts.harmonicSnr,
          fundamentalRatio: opts.fundamentalRatio,
          notes,
        });
      } catch (_e) {
        return null;
      }
    },
  };
}

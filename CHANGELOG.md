# Changelog

All notable changes to Strum Fighter are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/).

## [0.3.1] — 2026-06-19

### Fixed
- **Crash on the run-ending hit.** When an incoming enemy bolt landed the final
  hull point, its `onArrive()` callback ran `endRun()` synchronously from inside
  `weapons.update()`'s effect loop — that tears the game down (`sdk.end()` →
  `cleanup()` → `weapons.dispose()` → `reset()`), emptying the `effects` array
  mid-iteration. The loop then dereferenced a now-undefined slot and threw
  `Cannot read properties of undefined (reading 'dispose')`. `update()` now
  snapshots each effect and guards against re-entrant teardown, `dispose()` is
  idempotent, and `reset()` is null-safe.

## [0.3.0] — 2026-06-12

Ear-training — enemies can voice their chord, and the letters can fade or vanish.

### Added
- **Enemy chord sounds.** Optional: when locked, an enemy "strums" its chord
  (Karplus-Strong plucked strings, low-to-high stagger), panned by its on-screen
  position and louder when nearer. Runs on its own audio bus, so it works with the
  backing music off, and ducks for ~280 ms after you strum so it never bleeds into
  the chord scorer. New **Enemy chord sound** toggle (default off).
- **Chord-label modes.** New **Chord labels** modifier: `on` (default — unchanged
  casual play), `fade` (the letter shows at spawn and fades as the fighter closes,
  weaning you off the text), `off` (no letters — pure ear-only; auto-enables the
  chord sound). Bosses hide their progression letters in fade/off (shield pips +
  progress glyphs still show), and — when Enemy chord sound is on — voice each new
  plate's chord as you peel it.
- **Post-kill chord reveal.** In fade/ear modes, the chord name flashes at the
  explosion when you destroy a target — so you find out whether your ear was right.
  This closes the practice loop (guess → strum → confirm).

### Notes
- The default run is byte-for-byte the same casual game as 0.2.x; ear-training is
  entirely opt-in. Chord cues are clean on a direct guitar input (DI/pickup); on a
  microphone, loud monitoring could in principle bleed into detection.

## [0.2.0] — 2026-06-12

Phase 2/3 upgrade — bosses, livery unlocks, and a visual/audio polish pass.

### Added
- **Boss gunships.** Every few waves (and always the final wave) a heavy boss
  warps in, armoured by a **chord progression**: strum the highlighted chord to
  peel one shield plate and advance to the next. Peel them all to expose and
  detonate the core. The boss holds at range, weaves, and lays down sustained
  fire — kill it before it grinds your hull down. Progressions are difficulty-
  scoped (open → barre → 7ths) and named (Ace of Spades, Seventh Heaven, …).
- **Boss shields you can see.** A segmented shield bar across the top of the HUD,
  plus per-plate pips and a done/current/upcoming progression read-out painted on
  the boss itself, so its "health" is unmistakable as you fight it.
- **XP-gated liveries.** The `skin_ace` (250 XP) and `skin_squad` (1000 XP)
  unlocks now actually re-theme the cockpit: HUD accent, gun-tracer colour, and
  fill-light tint. New **Livery** modifier (`auto` picks your highest unlocked).
- **Richer ships.** Rebuilt fighter silhouette (fuselage + nose + canopy + swept
  wings + wingtip pods + twin engines); the boss adds outboard nacelles and a
  cannon spine.
- **Backdrop & juice.** Distant rotating planet with an atmosphere halo, drifting
  multi-layer nebulae, lock-on converge animation, wave banners, bonus toasts
  (Wave Clear / Flawless / Boss Down), combo pulse, and a boss-alert red wash.
- **Deeper scoring.** Wave-clear bonus (scales with wave), flawless-wave bonus,
  and a big boss-kill bonus; richer run summary (bosses downed, livery).
- **Audio.** Boss waves switch to a faster, heavier groove with a kick; added a
  warp-in stinger and a larger boss detonation boom.

### Tuning
- Expanded chord pools (added `Fmaj7`, `E7`, `A7`, `D7`).

## [0.1.4] — 2026-06-08

Initial release — a first-person cockpit **chord-shooter** minigame for Slopsmith.

### Added
- **Chart-free chord detection** via the desktop engine's harmonic-comb scorer
  (`scoreChord`) — strum the chord painted on the locked enemy to destroy it. No
  song or highway required.
- **3D cockpit scene** (Three.js, loaded from core's vendored copy): hyperspace
  starfield streaks, nebula backdrop, and a 2D cockpit HUD with canopy + dashboard.
- **Maneuvering fighters** that weave, bank/roll, and make strafing firing passes.
- **Enemies shoot back** — fighters fire at the cockpit then peel off; incoming
  bolts cost hull.
- **Background battle ambiance** — friendly/enemy flyby ships + distant explosions.
- **Flight-feel camera** — idle sway, slow roll, banking toward the locked target,
  and recoil/impact shake.
- **Juice** — traveling tracer bolts, shockwave explosions with tumbling debris.
- **Difficulty tiers** (easy/medium/hard), **wave-count** and **music** modifiers.
- Score + combo, hull integrity, and run summary via the Minigames SDK (XP,
  leaderboard, profile handled by the framework).

### Notes
- Requires the **Slopsmith desktop app** (the chord scorer runs on the native
  audio engine) and the **Minigames** plugin. Browser-only builds show a graceful
  "needs desktop" panel.

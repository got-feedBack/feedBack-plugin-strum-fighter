// Strum Fighter — a first-person cockpit chord-shooter minigame for Slopsmith.
//
// You fly through a space battle; each enemy fighter has a chord name painted
// on it by the HUD. The reticle auto-locks the nearest enemy — strum its chord
// to destroy it. A correct strum detonates the fighter; a wrong chord fires but
// misses. Every few waves a BOSS gunship warps in, armoured by a chord
// PROGRESSION you peel one shield plate at a time. Chord detection is
// chart-free via the desktop engine's scoreChord() (no song/highway needed).
//
// Architecture: this entry file loads Three.js (vendored in core) and the ES
// modules under assets/modules/, then orchestrates the game loop. The modules:
//   chords.js      — chord dictionary + difficulty tiers + boss progressions
//   skins.js       — XP-gated cockpit liveries
//   audio-input.js — strum-onset detection + scoreChord wrapper
//   scene.js       — Three.js scene/camera/renderer/starfield/planet
//   enemies.js     — enemy fighters + boss gunship + billboarded labels
//   weapons.js     — tracers / muzzle flash / explosions / boss FX
//   hud.js         — 2D cockpit HUD overlay
//   synth.js       — backing groove + SFX

(function () {
  'use strict';

  const PLUGIN_ID = 'strum_fighter';
  // Bump BUILD with every module change so a normal reload refetches the ES
  // modules (their import URLs are otherwise uncached). Keep in sync with
  // plugin.json "version".
  const BUILD = '0.3.4';
  const MODULES = `/api/plugins/${PLUGIN_ID}/assets/modules/`;
  const mod = (name) => import(`${MODULES}${name}?v=${BUILD}`);
  // Three.js is vendored in core (pinned r170); fall back to CDN if absent.
  const THREE_URL = '/static/vendor/three/three.module.min.js';
  const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';

  let T = null, threePromise = null;
  function loadThree() {
    if (!threePromise) {
      threePromise = import(THREE_URL)
        .then(m => { T = m; return m; })
        .catch(() => import(THREE_CDN)
          .then(m => { T = m; return m; })
          .catch(e => { console.error('[strum_fighter] Three.js load failed:', e); threePromise = null; throw e; }));
    }
    return threePromise;
  }

  // ── Minigame registration (late-bind to the SDK; queue if it's not up) ──
  function postSpec(spec) {
    // Prefer the post-rename SDK (#537); fall back to the legacy global for
    // hosts that predate the slopsmith→feedBack rename.
    const mg = window.feedBackMinigames || window.slopsmithMinigames;
    if (mg && mg.register) {
      mg.register(spec);
    } else {
      // SDK not up yet — queue under both pending-queue names so whichever
      // host (pre- or post-rename) drains its own queue and picks us up. The
      // host's register() is keyed on spec.id, so being drained from both is
      // harmless.
      (window.__feedBackMinigamesPending = window.__feedBackMinigamesPending || []).push(spec);
      (window.__slopsmithMinigamesPending = window.__slopsmithMinigamesPending || []).push(spec);
    }
  }

  let runState = null;

  function panel(container, html) {
    container.style.background = 'radial-gradient(circle at 50% 40%, #0b1430, #05060d)';
    container.innerHTML =
      `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;` +
      `text-align:center;color:#cfe2ff;font-family:system-ui,sans-serif;padding:40px;">` +
      `<div style="max-width:520px">${html}</div></div>`;
  }

  async function startGame({ container, modifiers, sdk }) {
    modifiers = modifiers || {};

    // Load the chart-free chord scorer's home (the desktop engine) + audio mod.
    let audioMod;
    try {
      audioMod = await mod('audio-input.js');
    } catch (e) {
      panel(container, 'Failed to load Strum Fighter modules.');
      return;
    }
    if (!audioMod.hasEngine()) {
      panel(container,
        `<div style="font-size:42px;margin-bottom:10px">🎸🛸</div>` +
        `<div style="font-size:22px;font-weight:800;margin-bottom:10px">Strum Fighter needs the desktop app</div>` +
        `<div style="opacity:.8;line-height:1.5">Chord detection runs on the native audio engine, so this minigame ` +
        `only plays in the Slopsmith desktop app with your guitar plugged in. ` +
        `Open it there, pick your input device, and strum away.</div>`);
      runState = { cleanup() { container.innerHTML = ''; } };
      return;
    }

    let THREE;
    try {
      THREE = await loadThree();
    } catch (e) {
      panel(container, 'Could not load the 3D engine (Three.js). Check your connection or the desktop bundle.');
      runState = { cleanup() { container.innerHTML = ''; } };
      return;
    }

    // Load the rest of the modules in parallel.
    let chords, skinsMod, sceneMod, enemiesMod, weaponsMod, hudMod, synthMod, ambianceMod;
    try {
      [chords, skinsMod, sceneMod, enemiesMod, weaponsMod, hudMod, synthMod, ambianceMod] = await Promise.all([
        mod('chords.js'),
        mod('skins.js'),
        mod('scene.js'),
        mod('enemies.js'),
        mod('weapons.js'),
        mod('hud.js'),
        mod('synth.js'),
        mod('ambiance.js'),
      ]);
    } catch (e) {
      panel(container, 'Failed to load Strum Fighter modules.');
      runState = { cleanup() { container.innerHTML = ''; } };
      return;
    }

    // ── Config from modifiers ──
    const difficulty = modifiers.difficulty || 'medium';
    const tier = chords.tierParams(difficulty);
    const chordPool = chords.pool(difficulty);
    const totalWaves = chords.waveCount(modifiers.length || 'normal');
    const musicOn = (modifiers.music || 'on') !== 'off';
    // Ear-training: label visibility + whether enemies voice their chord. With
    // labels fully off there'd be no cue at all, so force the chord sound on.
    let labelMode = ['on', 'fade', 'off'].includes(modifiers.labels) ? modifiers.labels : 'on';
    let chordSoundOn = (modifiers.chord_sound || 'off') === 'on';
    if (labelMode === 'off') chordSoundOn = true;
    // Write the sanitized/forced values back so the run record + analytics
    // (sdk.end uses modifiers) reflect what the player actually experienced.
    modifiers.labels = labelMode;
    modifiers.chord_sound = chordSoundOn ? 'on' : 'off';
    const bossWaveSet = chords.bossWaves(totalWaves, tier.bossEvery);
    // Escorts that fly with a boss, by difficulty.
    const ESCORTS = { easy: 0, medium: 2, hard: 3 };
    const escortCount = ESCORTS[difficulty] != null ? ESCORTS[difficulty] : 2;

    // ── Resolve the active livery from profile unlocks + the chosen modifier ──
    let skin = skinsMod.SKINS.default;
    try {
      const profile = sdk && sdk.getProfile ? await sdk.getProfile() : null;
      const owned = skinsMod.ownedSkinIds(profile && profile.unlocks, PLUGIN_ID);
      skin = skinsMod.resolveSkin(modifiers.livery || 'auto', owned);
    } catch (_e) { /* offline / no profile — keep default livery */ }

    container.style.background = '#05060d';
    container.innerHTML = '';

    // ── Build subsystems ──
    const scene = sceneMod.createScene(THREE, container);
    scene.setSkin(skin);
    const enemies = enemiesMod.createEnemies(THREE, scene.scene, {
      toNotes: chords.toNotes,
      SPAWN_Z: sceneMod.SPAWN_Z,
      BREACH_Z: sceneMod.BREACH_Z,
      PLAY_HALF_W: sceneMod.PLAY_HALF_W,
      PLAY_HALF_H: sceneMod.PLAY_HALF_H,
    });
    const weapons = weaponsMod.createWeapons(THREE, scene.scene, scene.camera);
    weapons.setSkin(skin);
    enemies.setLabelMode(labelMode);
    const hud = hudMod.createHud(container);
    const synth = synthMod.createSynth();
    synth.setEnabled(musicOn);
    synth.setCueEnabled(chordSoundOn);
    const ambiance = ambianceMod.createAmbiance(THREE, scene.scene);

    const audio = audioMod.createAudioInput({ onStrum: handleStrum, onLevel: null });
    audio.setScoreOpts({
      pitchCheckCents: tier.pitchCheckCents,
      minHitRatio: tier.minHitRatio,
      harmonicSnr: tier.harmonicSnr,
      fundamentalRatio: tier.fundamentalRatio,
    });

    const ro = new ResizeObserver(() => { scene.resize(); hud.resize(); });
    ro.observe(container);

    // ── Game state ──
    const HULL_MAX = 6;
    let score = 0, combo = 1, hull = HULL_MAX, wave = 1, kills = 0, bossKills = 0;
    let strums = 0, hits = 0;
    let locked = null, lockedRef = null, lockId = 0, lockCueAt = 0;
    let lastVerdict = null, comboAt = 0, banner = null, toast = null, reveal = null;
    const FADE_NEAR_Z = -45; // depth where a faded chord label hits zero

    // Enemy "voices" its chord, panned by screen-x and louder when nearer.
    function cueLocked(e) {
      if (gameOver || !e || !chordSoundOn || e.dead || e.dying) return;
      const pan = Math.max(-1, Math.min(1, e.group.position.x / sceneMod.PLAY_HALF_W));
      const dist = Math.max(8, -e.group.position.z);
      const gain = Math.max(0.25, Math.min(1, 80 / dist));
      // Only advance the cue timer / trigger the ♪ pulse if audio actually fired
      // (cueChord bails inside the post-strum duck window).
      if (synth.cueChord(e.chordNotes, { pan, gain })) lockCueAt = performance.now();
    }

    // Alpha for the HUD's locked-chord letters (top-center + bracket).
    function lockedLabelAlpha(e) {
      if (!e) return 0;
      if (labelMode === 'on') return 1;
      // Reached only when mode is 'fade'/'off' ('on' returned above); bosses
      // always hide their chord letters in those modes.
      if (labelMode === 'off' || e.boss) return 0;
      const a = (FADE_NEAR_Z - e.group.position.z) / (FADE_NEAR_Z - sceneMod.SPAWN_Z);
      return Math.max(0, Math.min(1, a));
    }

    // Flash the chord name at a kill (ear-training answer); no-op in 'on' mode.
    function revealAt(worldPos, text) {
      if (labelMode === 'on') return;
      const ndc = worldPos.clone().project(scene.camera);
      if (ndc.z >= 1) return;
      reveal = {
        text,
        x: (ndc.x * 0.5 + 0.5) * container.clientWidth,
        y: (-ndc.y * 0.5 + 0.5) * container.clientHeight,
        at: performance.now(),
      };
    }
    let spawnedThisWave = 0, spawnAcc = 0, waveDamage = 0, runDamage = 0;
    let escortTarget = 0, waveActive = false;
    let gameOver = false, ended = false;
    const startedAt = performance.now();

    function isBossWave(w) { return bossWaveSet.has(w); }
    function takeDamage(n) {
      hull -= n; waveDamage += n; runDamage += n; combo = 1;
      hud.flash('miss');
      if (hull <= 0) { hull = 0; endRun('destroyed'); }
    }
    function awardToast(text) { toast = { text, at: performance.now() }; }

    function startWave() {
      waveActive = true;
      spawnedThisWave = 0; spawnAcc = 0; waveDamage = 0;
      if (isBossWave(wave)) {
        escortTarget = escortCount;
        const prog = chords.bossProgression(difficulty);
        const boss = enemies.spawnBoss(prog);
        boss.bossSpeed = tier.bossSpeed;
        scene.setAlert(true);
        scene.setWarp(130);
        synth.setIntensity(1);
        synth.stinger();
        scene.addShake(0.5);
        banner = { text: 'BOSS INCOMING', sub: prog.name, at: performance.now(), boss: true };
      } else {
        escortTarget = enemiesThisWave(wave);
        scene.setAlert(false);
        scene.setWarp(90);
        synth.setIntensity(0);
        banner = { text: `WAVE ${wave}`, sub: wave === totalWaves ? 'Final wave' : null, at: performance.now(), boss: false };
      }
    }

    function enemiesThisWave(w) { return tier.perWaveBase + (w - 1) * tier.perWaveGrow; }

    async function handleStrum() {
      if (gameOver) return;
      strums++;
      synth.duck();  // keep the chord cue out of the scoring window
      synth.laser();
      scene.addShake(0.12); // gun recoil
      const target = locked;
      if (!target || target.dead || target.dying) return; // fired into space
      const chordName = target.chordName;
      const chordNotes = target.chordNotes;
      const isBoss = !!target.boss;
      // Let the chord ring out for a moment before scoring — the attack
      // transient is noisy; the sustained ring reads cleaner.
      await new Promise((r) => setTimeout(r, 55));
      if (gameOver || target.dead || target.dying) return;
      const result = await audio.score(chordNotes);
      console.debug('[strum_fighter] strum', chordName, '->',
        result ? `isHit=${result.isHit} score=${(result.score || 0).toFixed(2)} ${result.hitStrings}/${result.totalStrings}` : 'null');
      if (gameOver || target.dead || target.dying) return;
      const pos = target.group.position.clone();

      if (result && result.isHit) {
        hits++;
        const acc = 0.5 + 0.5 * (typeof result.score === 'number' ? result.score : 1);
        weapons.fire(pos, true);

        if (isBoss) {
          const r = enemies.hitBoss(target);
          if (!r) return;
          if (r.destroyed) {
            const bonus = 1000 + 250 * r.plateIdx;
            score += Math.round(150 * combo * acc) + bonus;
            bossKills++; // counted under "Bosses destroyed", not "Fighters downed"
            weapons.bossExplode(r.pos, r.color);
            synth.bossBoom();
            scene.addShake(0.9);
            hud.flash('hit');
            revealAt(r.pos, chordName);
            awardToast(`BOSS DOWN  +${bonus}`);
            scene.setAlert(false); scene.setWarp(90); synth.setIntensity(0);
            lastVerdict = { kind: 'hit', text: `${chordName} ✓  core destroyed`, at: performance.now() };
          } else {
            score += Math.round(150 * combo * acc);
            weapons.shieldHit(r.pos);
            synth.explosion();
            scene.addShake(0.35);
            hud.flash('hit');
            revealAt(r.pos, chordName);
            // Voice the boss's NEW current chord just after the strum-duck
            // window so the player hears the next plate's target.
            setTimeout(() => cueLocked(target), 320);
            lastVerdict = { kind: 'hit', text: `${chordName} ✓  plate ${r.plateIdx}/${target.plates}`, at: performance.now() };
          }
        } else {
          const pts = Math.round(100 * combo * acc);
          score += pts;
          kills++;
          const fx = enemies.kill(target);
          if (fx) weapons.explode(fx.pos, fx.color);
          scene.addShake(0.35);
          synth.explosion();
          hud.flash('hit');
          revealAt(fx ? fx.pos : pos, chordName);
          lastVerdict = { kind: 'hit', text: `${chordName} ✓  +${pts}  (${result.hitStrings}/${result.totalStrings})`, at: performance.now() };
        }
        // Bump combo AFTER scoring so the first hit counts as x1, not x2.
        combo = Math.min(99, combo + 1); comboAt = performance.now();
      } else {
        combo = 1;
        weapons.fire(pos, false);
        hud.flash('miss');
        const rs = result ? `rang ${result.hitStrings}/${result.totalStrings}` : 'no signal';
        lastVerdict = { kind: 'miss', text: `${chordName} ✗  (${rs})`, at: performance.now() };
      }
    }

    function spawnNext() {
      const name = chordPool[(Math.random() * chordPool.length) | 0];
      enemies.spawn(name);
      spawnedThisWave++;
    }

    function endRun(reason) {
      if (ended) return;
      ended = true; gameOver = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      const accuracy = strums > 0 ? Math.round((hits / strums) * 100) : 0;
      const won = reason === 'cleared';
      const summaryHtml =
        `<div>${won ? 'Sector cleared! ✦' : 'Cockpit breached.'}</div>` +
        `<div style="margin-top:6px">Fighters downed: <b>${kills}</b></div>` +
        `<div>Bosses destroyed: <b>${bossKills}</b></div>` +
        `<div>Accuracy: <b>${accuracy}%</b></div>` +
        `<div>Hull lost: <b>${runDamage}</b></div>` +
        `<div>Reached wave: <b>${wave}/${totalWaves}</b></div>` +
        `<div>Livery: <b>${skin.label}</b></div>` +
        (labelMode !== 'on'
          ? `<div>Ear training: <b>${labelMode === 'off' ? 'Ear-only' : 'Fade'}</b></div>`
          : '');
      // sdk.end() calls spec.stop() → stopGame() → cleanup(), which disposes
      // all GL/audio resources, so we don't tear down here.
      sdk.end({
        score,
        durationMs: Math.round(performance.now() - startedAt),
        modifiers,
        meta: { wave, kills, bossKills, accuracy, hullLost: runDamage, reason, difficulty, livery: skin.id, labels: labelMode, chordSound: chordSoundOn },
        summaryHtml,
      });
    }

    // ── Main loop ──
    let raf = 0, last = performance.now();
    function frame(now) {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;

      if (!gameOver) {
        if (!waveActive) startWave();

        // Spawn escorts/fighters for the current wave.
        if (spawnedThisWave < escortTarget) {
          spawnAcc += dt * 1000;
          if (spawnAcc >= tier.spawnEveryMs) { spawnAcc = 0; spawnNext(); }
        }

        // Advance enemies; a ship that rams the cockpit (without having made a
        // firing pass) costs hull. The boss never breaches.
        const breached = enemies.update(dt, tier.enemySpeed);
        let breachDmg = 0;
        for (const e of breached) if (!e.fired) breachDmg++;
        if (breachDmg > 0) { scene.addShake(0.5); takeDamage(breachDmg); }

        // Lock the nearest enemy (boss outranks fighters) + bank toward it.
        locked = enemies.nearest();
        if (locked !== lockedRef) {
          lockedRef = locked; lockId++;
          cueLocked(locked); // announce the new target's chord
        } else if (locked && performance.now() - lockCueAt > 3500) {
          cueLocked(locked); // periodic reminder while still lined up
        }
        enemies.setLocked(locked);
        scene.setLean(locked ? locked.group.position.x / sceneMod.PLAY_HALF_W : 0);

        // Regular fighters that reach firing range shoot once, then peel off.
        const FIRE_Z = -45;
        for (const e of enemies.list()) {
          if (e.boss || e.dying || e.dead || e.fired) continue;
          if (e.group.position.z > FIRE_Z) {
            enemies.peel(e);
            weapons.enemyShot(e.group.position.clone(), () => {
              if (gameOver) return;
              scene.addShake(0.7); takeDamage(1);
            });
          }
        }

        // Boss keeps up sustained fire while it holds.
        const boss = enemies.bossInPlay();
        if (boss && boss.atHold && !gameOver) {
          boss.fireAcc += dt;
          // tier.bossShots is the SECONDS BETWEEN boss shots (a cooldown), not a
          // shot count — smaller = more frequent fire.
          if (boss.fireAcc >= tier.bossShots) {
            boss.fireAcc = 0;
            weapons.enemyShot(boss.group.position.clone(), () => {
              if (gameOver) return;
              scene.addShake(0.6); takeDamage(1);
            });
          }
        }

        // Wave / win progression — wave ends once everything (incl. boss) is
        // down and the escort quota has finished spawning.
        if (!gameOver && spawnedThisWave >= escortTarget && enemies.aliveCount() === 0) {
          const flawless = waveDamage === 0;
          const clearBonus = 200 * wave + (flawless ? 300 : 0);
          score += clearBonus;
          if (wave >= totalWaves) { endRun('cleared'); }
          else {
            awardToast(flawless ? `FLAWLESS WAVE  +${clearBonus}` : `WAVE CLEAR  +${clearBonus}`);
            wave++; waveActive = false;
          }
        }
      }

      // endRun() → sdk.end() → stopGame() → cleanup() disposes the renderer
      // synchronously, so bail before touching disposed GL/HUD objects.
      if (ended) return;

      ambiance.update(dt);
      scene.update(dt);
      weapons.update(dt);
      scene.render();

      // Project the locked enemy to screen space so the HUD can bracket it.
      let lockedScreen = null;
      if (locked && !locked.dead && !locked.dying) {
        const ndc = locked.group.position.clone().project(scene.camera);
        if (ndc.z < 1) {
          const dist = Math.max(8, -locked.group.position.z);
          lockedScreen = {
            x: (ndc.x * 0.5 + 0.5) * container.clientWidth,
            y: (-ndc.y * 0.5 + 0.5) * container.clientHeight,
            r: Math.max(34, Math.min(locked.boss ? 230 : 150, (locked.boss ? 6200 : 2600) / dist)),
          };
        }
      }

      const bossE = enemies.bossInPlay();
      hud.update({
        score, combo, comboAt, hull, hullMax: HULL_MAX, wave, waveCount: totalWaves,
        locked: locked ? locked.chordName : null,
        lockedIsBoss: !!(locked && locked.boss),
        boss: bossE ? { name: bossE.progName, idx: bossE.progIdx, plates: bossE.plates } : null,
        level: audio.getLevel(),
        lockedScreen, lockKey: lockId, verdict: lastVerdict, toast, banner, reveal,
        lockedLabelAlpha: lockedLabelAlpha(locked),
        cueAt: chordSoundOn ? lockCueAt : 0,
        skin: { accent: skin.accent, badge: skin.badge, label: skin.label },
      });

      if (!ended) raf = requestAnimationFrame(frame);
    }

    audio.start();
    // Prime the synth even when music is off so chord cues can play (start()
    // resumes the audio context but only runs the groove when music is on).
    if (musicOn || chordSoundOn) synth.start();
    raf = requestAnimationFrame(frame);

    runState = {
      cleanup() {
        gameOver = true; ended = true;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        try { ro.disconnect(); } catch (_e) {}
        try { audio.stop(); } catch (_e) {}
        try { synth.stop(); } catch (_e) {}
        try { ambiance.dispose(); } catch (_e) {}
        try { weapons.dispose(); } catch (_e) {}
        try { enemies.dispose(); } catch (_e) {}
        try { scene.dispose(); } catch (_e) {}
        try { hud.dispose(); } catch (_e) {}
        container.innerHTML = '';
      },
    };
  }

  function stopGame() {
    if (runState && runState.cleanup) runState.cleanup();
    runState = null;
  }

  // ── Register ──
  postSpec({
    id: PLUGIN_ID,
    title: 'Strum Fighter',
    tagline: 'Strum the chord, kill the fighter',
    thumbnail: 'thumb.png',
    modifiers: [
      { id: 'difficulty', label: 'Difficulty', default: 'medium', values: ['easy', 'medium', 'hard'] },
      { id: 'length', label: 'Waves', default: 'normal', values: ['short', 'normal', 'long'] },
      { id: 'livery', label: 'Livery', default: 'auto', values: ['auto', 'default', 'ace', 'squad'] },
      { id: 'labels', label: 'Chord labels', default: 'on', values: ['on', 'fade', 'off'] },
      { id: 'chord_sound', label: 'Enemy chord sound', default: 'off', values: ['off', 'on'] },
      { id: 'music', label: 'Music', default: 'on', values: ['on', 'off'] },
    ],
    start: startGame,
    stop: stopGame,
  });
})();

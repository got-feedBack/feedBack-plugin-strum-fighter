// Strum Fighter — guns: muzzle flash, tracer beams, explosions.
//
// Forward-facing cockpit guns. On every strum we fire two tracers from the
// lower corners of the view; a hit converges on the target and detonates it,
// a wrong chord veers slightly past (the "shoots but misses" feedback). Tracer
// colour follows the active livery (setSkin). The boss adds a shield-peel
// ripple per plate and a much larger core detonation.
// Receives the Three.js module (T), the scene, and the camera from game.js.

function makeDotTexture(T) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new T.CanvasTexture(c);
}

export function createWeapons(T, scene, camera) {
  const effects = [];
  let disposed = false;
  const gBeam = new T.BoxGeometry(1, 1, 1); // unit; scaled per beam
  const gShard = new T.BoxGeometry(0.5, 0.5, 0.95);
  const dotTex = makeDotTexture(T);
  const ringTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const cx = c.getContext('2d');
    cx.strokeStyle = 'rgba(255,255,255,1)';
    cx.lineWidth = 10;
    cx.beginPath(); cx.arc(64, 64, 52, 0, Math.PI * 2); cx.stroke();
    return new T.CanvasTexture(c);
  })();

  // Player tracer / muzzle colours — re-themed by the active livery.
  let tracerColor = 0x66ffcc;
  let muzzleColor = 0x66ffcc;

  // Two gun muzzles in the lower corners of the cockpit view.
  const MUZZLES = [new T.Vector3(-3.2, -2.6, -1.5), new T.Vector3(3.2, -2.6, -1.5)];

  function _beam(from, to, color, opacity, life) {
    const op = opacity == null ? 0.9 : opacity;
    const ttl = life == null ? 0.14 : life;
    const mat = new T.MeshBasicMaterial({ color, transparent: true, opacity: op, fog: false });
    const mesh = new T.Mesh(gBeam, mat);
    const len = from.distanceTo(to);
    mesh.position.copy(from).lerp(to, 0.5);
    mesh.lookAt(to);
    mesh.scale.set(0.16, 0.16, len);
    scene.add(mesh);
    let t = ttl;
    effects.push({
      update(dt) { t -= dt; mat.opacity = Math.max(0, t / ttl) * op; return t > 0; },
      dispose() { scene.remove(mesh); mat.dispose(); },
    });
  }

  function _flash(pos, color, size) {
    const sz = size || 2.4;
    const mat = new T.SpriteMaterial({ map: dotTex, color, transparent: true, opacity: 1, blending: T.AdditiveBlending, depthTest: false, fog: false });
    const s = new T.Sprite(mat);
    s.position.copy(pos);
    s.scale.set(sz, sz, 1);
    scene.add(s);
    let life = 0.12;
    effects.push({
      update(dt) {
        life -= dt;
        const k = Math.max(0, life / 0.12);
        mat.opacity = k;
        s.scale.setScalar(sz * (1 + (1 - k) * 1.5));
        return life > 0;
      },
      dispose() { scene.remove(s); mat.dispose(); },
    });
  }

  // A bright bolt that travels from the muzzle to the aim point.
  function _bolt(from, to, color) {
    const mat = new T.SpriteMaterial({ map: dotTex, color, transparent: true, opacity: 1, blending: T.AdditiveBlending, depthTest: false, fog: false });
    const s = new T.Sprite(mat);
    s.scale.set(1.6, 1.6, 1);
    s.position.copy(from);
    scene.add(s);
    let t = 0; const dur = 0.09;
    effects.push({
      update(dt) {
        t += dt;
        const k = Math.min(1, t / dur);
        s.position.copy(from).lerp(to, k);
        mat.opacity = 1 - k * 0.25;
        return t < dur;
      },
      dispose() { scene.remove(s); mat.dispose(); },
    });
  }

  // An expanding shockwave ring sprite at `pos`.
  function _ring(pos, color, from, to, dur, opacity) {
    const mat = new T.SpriteMaterial({ map: ringTex, color, transparent: true, opacity: opacity || 0.9, blending: T.AdditiveBlending, depthTest: false, fog: false });
    const ring = new T.Sprite(mat);
    ring.position.copy(pos);
    ring.scale.setScalar(from);
    scene.add(ring);
    let t = 0;
    effects.push({
      update(dt) {
        t += dt; const k = t / dur;
        ring.scale.setScalar(from + k * (to - from));
        mat.opacity = Math.max(0, (opacity || 0.9) * (1 - k));
        return t < dur;
      },
      dispose() { scene.remove(ring); mat.dispose(); },
    });
  }

  // A spark burst of `n` points at `pos` flying outward.
  function _sparks(pos, color, n, speed, size, ttl) {
    const positions = new Float32Array(n * 3);
    const vel = [];
    for (let i = 0; i < n; i++) {
      positions[i * 3] = pos.x; positions[i * 3 + 1] = pos.y; positions[i * 3 + 2] = pos.z;
      const sp = speed * (0.5 + Math.random());
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(Math.random() * 2 - 1);
      vel.push(new T.Vector3(Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)).multiplyScalar(sp));
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(positions, 3));
    const mat = new T.PointsMaterial({ map: dotTex, color, size, transparent: true, opacity: 1, blending: T.AdditiveBlending, depthTest: false, sizeAttenuation: true, fog: false });
    const pts = new T.Points(geo, mat);
    scene.add(pts);
    effects.push({
      update(dt) {
        this._t = (this._t || 0) + dt;
        const arr = geo.attributes.position.array;
        for (let i = 0; i < n; i++) {
          vel[i].multiplyScalar(Math.pow(0.02, dt));
          arr[i * 3] += vel[i].x * dt;
          arr[i * 3 + 1] += vel[i].y * dt;
          arr[i * 3 + 2] += vel[i].z * dt;
        }
        geo.attributes.position.needsUpdate = true;
        mat.opacity = Math.max(0, 1 - this._t / ttl);
        return this._t < ttl;
      },
      dispose() { scene.remove(pts); geo.dispose(); mat.dispose(); },
    });
  }

  function _debris(pos, color, n, speed, ttl) {
    for (let i = 0; i < n; i++) {
      const sm = new T.MeshBasicMaterial({ color, fog: false, transparent: true });
      const sh = new T.Mesh(gShard, sm);
      sh.position.copy(pos);
      scene.add(sh);
      const dv = new T.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(speed * (0.6 + Math.random() * 0.8));
      const rx = (Math.random() * 2 - 1) * 8, ry = (Math.random() * 2 - 1) * 8;
      effects.push({
        update(dt) {
          this._t = (this._t || 0) + dt;
          sh.position.addScaledVector(dv, dt);
          dv.multiplyScalar(Math.pow(0.2, dt));
          sh.rotation.x += rx * dt; sh.rotation.y += ry * dt;
          sm.opacity = Math.max(0, 1 - this._t / ttl);
          return this._t < ttl;
        },
        dispose() { scene.remove(sh); sm.dispose(); },
      });
    }
  }

  // Fire both guns toward target. `hit` converges on it; otherwise the beams
  // pass slightly wide.
  function fire(targetPos, hit) {
    const aim = targetPos.clone();
    if (!hit) {
      aim.x += (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 3);
      aim.y += (Math.random() * 2 - 1) * 3;
    }
    const beamColor = hit ? tracerColor : 0xff5566;
    for (const m of MUZZLES) {
      _flash(m, hit ? muzzleColor : 0xff5566);
      _beam(m, aim, beamColor);
      _bolt(m, aim, beamColor);
    }
  }

  // An enemy fires a bolt at the cockpit. It streaks in and grows; onArrive
  // fires once when it reaches the player (the hull-damage hook).
  function enemyShot(fromPos, onArrive) {
    const to = new T.Vector3((Math.random() * 2 - 1) * 1.4, (Math.random() * 2 - 1) * 0.9, 2.2);
    const color = 0xff4444;
    _beam(fromPos, to, color);
    const mat = new T.SpriteMaterial({ map: dotTex, color, transparent: true, opacity: 1, blending: T.AdditiveBlending, depthTest: false, fog: false });
    const s = new T.Sprite(mat);
    s.scale.set(2, 2, 1);
    s.position.copy(fromPos);
    scene.add(s);
    let t = 0; const dur = 0.55; let arrived = false;
    effects.push({
      update(dt) {
        t += dt;
        const k = Math.min(1, t / dur);
        s.position.copy(fromPos).lerp(to, k);
        s.scale.setScalar(2 + k * 3);
        if (k >= 1 && !arrived) { arrived = true; if (onArrive) onArrive(); }
        return t < dur;
      },
      dispose() { scene.remove(s); mat.dispose(); },
    });
  }

  // Boss plate peeled (but core still alive): a bright shield ripple + spark
  // puff at the impact point, in the player's tracer colour.
  function shieldHit(pos) {
    _flash(pos, tracerColor, 4);
    _ring(pos, tracerColor, 3, 16, 0.45, 0.85);
    _sparks(pos, tracerColor, 36, 24, 2.4, 0.5);
  }

  // Full detonation at pos: spark burst + shockwave ring + tumbling debris.
  function explode(pos, color) {
    _sparks(pos, color, 90, 30, 2.8, 0.7);
    _ring(pos, 0xffffff, 2, 24, 0.4, 0.9);
    _debris(pos, color, 8, 22, 0.6);
    _flash(pos, 0xffffff);
  }

  // The boss core goes up: layered rings, a huge spark cloud, heavy debris,
  // and a sustained white core flash.
  function bossExplode(pos, color) {
    _sparks(pos, color, 220, 46, 4.2, 1.1);
    _sparks(pos, 0xffffff, 90, 30, 3.0, 0.8);
    _ring(pos, 0xffffff, 3, 60, 0.6, 1);
    _ring(pos, color, 3, 90, 0.85, 0.9);
    _ring(pos, 0xffd0a0, 3, 44, 0.5, 0.9);
    _debris(pos, color, 22, 34, 1.0);
    _flash(pos, 0xffffff, 7);
    // A second, delayed bloom for a rolling-detonation feel.
    let t = 0;
    effects.push({
      update(dt) {
        t += dt;
        if (t >= 0.18 && !this._done) {
          this._done = true;
          _sparks(pos, 0xffe0b0, 80, 28, 3.4, 0.7);
          _ring(pos, 0xffffff, 3, 48, 0.45, 0.85);
        }
        return t < 0.2;
      },
      dispose() {},
    });
  }

  function update(dt) {
    if (disposed) return;
    for (let i = effects.length - 1; i >= 0; i--) {
      // Capture the effect up front: an effect's update() can re-enter and
      // mutate `effects` synchronously. The enemy bolt's onArrive() lands the
      // killing hull hit, which runs endRun() → sdk.end() → cleanup() →
      // dispose() → reset() and empties this array mid-loop. Without the
      // snapshot + guards below, `effects[i]` is then undefined and the
      // `.dispose()` call throws.
      const e = effects[i];
      if (!e) continue;
      if (!e.update(dt)) {
        if (disposed) return;            // teardown ran inside update()
        if (effects[i] === e) effects.splice(i, 1);
        e.dispose();
      }
    }
  }

  function reset() {
    for (const e of effects) if (e) e.dispose();
    effects.length = 0;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    reset();
    gBeam.dispose();
    gShard.dispose();
    dotTex.dispose();
    ringTex.dispose();
  }

  return {
    fire, enemyShot, shieldHit, explode, bossExplode, update, reset, dispose,
    setSkin(skin) { if (skin) { tracerColor = skin.tracer; muzzleColor = skin.muzzle; } },
  };
}

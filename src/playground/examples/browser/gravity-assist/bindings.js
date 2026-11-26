// 3D Gravity Assist Simulator — Editable Three.js bindings.
// Uses vendored `three` inside the sandboxed preview iframe (`import * as THREE from "three"`).
// Titan owns the 3D Velocity Verlet physics; this file renders Saturn, rings, Titan, Cassini,
// live 3D trajectories, and a spherical orbit camera.

import * as THREE from "three";

const MAX_TRAIL_POINTS = 1200;
const MAX_PRED_POINTS = 260;
const DEFAULT_TARGET = new THREE.Vector3(-2.5, 0, 0);

function hash01(seed) {
  const s = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function createSaturnTexture() {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  for (const [stop, color] of [
    [0, "#695d46"], [0.12, "#8e7b56"], [0.22, "#c6b078"], [0.34, "#e2d19a"],
    [0.46, "#f0e3b8"], [0.54, "#d7be82"], [0.66, "#e5d49f"], [0.78, "#b79d67"],
    [0.88, "#87724d"], [1, "#5c513d"],
  ]) grad.addColorStop(stop, color);
  g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
  for (let y = 0; y < c.height; y += 3) {
    g.fillStyle = y % 6 === 0 ? "rgba(255,248,220,0.08)" : "rgba(40,30,15,0.07)";
    g.fillRect(0, y, c.width, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createRingTexture() {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 4;
  const g = c.getContext("2d");
  const img = g.createImageData(c.width, c.height);
  for (let x = 0; x < c.width; x++) {
    const u = x / (c.width - 1);
    let r = 226, gr = 212, b = 152, a = 0;
    if (u < 0.16) {
      r = 160; gr = 144; b = 104; a = Math.round(70 * (u / 0.16));
    } else if (u < 0.56) {
      const k = 0.85 + 0.15 * Math.sin(u * 90);
      r = Math.round(234 * k); gr = Math.round(218 * k); b = Math.round(158 * k); a = Math.round(215 * k);
    } else if (u < 0.64) {
      r = 90; gr = 82; b = 60; a = 24; // Cassini Division
    } else if (u < 0.94) {
      const encke = Math.abs(u - 0.86) < 0.012 ? 0.15 : 1.0;
      const k = 0.9 + 0.1 * Math.cos(u * 120);
      r = Math.round(214 * k); gr = Math.round(202 * k); b = Math.round(156 * k); a = Math.round(175 * encke);
    }
    for (let y = 0; y < c.height; y++) {
      const idx = (y * c.width + x) * 4;
      img.data[idx] = r; img.data[idx + 1] = gr; img.data[idx + 2] = b; img.data[idx + 3] = a;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createTitanTexture() {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, "#b8742a"); grad.addColorStop(0.35, "#dfa043");
  grad.addColorStop(0.65, "#e6b45a"); grad.addColorStop(1, "#a86220");
  g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createRadialRingGeometry(innerR, outerR, segments) {
  const geom = new THREE.RingGeometry(innerR, outerR, segments, 1);
  const pos = geom.attributes.position, uv = geom.attributes.uv, v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    uv.setXY(i, (v.length() - innerR) / (outerR - innerR), 0.5);
  }
  return geom;
}

export default function createBindings(host) {
  const { root, canvas, signal } = host;

  root.style.cssText =
    "display:flex;flex-direction:column;align-items:center;gap:4px;padding:4px 6px;" +
    "background:#060807;color:#eae4d3;font-family:'IBM Plex Mono',ui-monospace,monospace;" +
    "box-sizing:border-box;width:100%;user-select:none;";

  canvas.width = 640;
  canvas.height = 400;
  canvas.tabIndex = 0;
  canvas.style.cssText =
    "display:block;width:min(100%,max(320px,calc((100vh - 128px) * 1.6)),640px);" +
    "height:auto;aspect-ratio:16/10;margin:0 auto;" +
    "border-radius:6px;border:1px solid rgba(226,216,152,0.22);background:#060807;" +
    "outline:none;cursor:grab;touch-action:none;";

  const topBar = document.createElement("div");
  topBar.style.cssText =
    "width:100%;max-width:640px;display:flex;flex-wrap:wrap;align-items:center;" +
    "justify-content:space-between;gap:4px;font-size:11px;background:#0f120d;" +
    "border:1px solid rgba(226,216,152,0.18);border-radius:5px;padding:3px 8px;box-sizing:border-box;";

  const hudStatus = document.createElement("div");
  hudStatus.setAttribute("role", "status");
  hudStatus.setAttribute("aria-live", "polite");
  hudStatus.style.cssText = "color:#e2d898;font-weight:600;white-space:nowrap;";
  hudStatus.textContent = "TITAN SLINGSHOT · INITIALIZING";

  const presetWrap = document.createElement("div");
  presetWrap.style.cssText = "display:flex;gap:4px;";

  const noteLine = document.createElement("div");
  noteLine.style.cssText =
    "width:100%;max-width:640px;font-size:11px;color:#b8b29b;display:flex;" +
    "justify-content:space-between;gap:8px;padding:0 2px;box-sizing:border-box;";
  const noteText = document.createElement("span");
  noteText.textContent = "Drag canvas to orbit 3D view · wheel to zoom";
  const bestBadge = document.createElement("span");
  bestBadge.style.color = "#a9d1be";
  bestBadge.textContent = "BEST 0";
  noteLine.append(noteText, bestBadge);

  const controlsPanel = document.createElement("div");
  controlsPanel.style.cssText =
    "width:100%;max-width:640px;display:flex;flex-direction:column;gap:4px;background:#0f120d;" +
    "border:1px solid rgba(226,216,152,0.16);border-radius:5px;padding:4px 8px;box-sizing:border-box;";
  const sliderRow = document.createElement("div");
  sliderRow.style.cssText = "display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;";
  const buttonRow = document.createElement("div");
  buttonRow.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;justify-content:center;";

  const inputState = {
    burn: false, retro: false, up: false, down: false, launch: false,
    restart: false, adjust: false, preset1: false, preset2: false, preset3: false,
  };
  const params = { angle: 0.0, speed: 5.1, pitch: 4.0, phase: 70.0 };
  const prefersReduced = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  let playing = !prefersReduced;
  let followShip = false;
  const timers = new Set();

  const sliderRefs = {};
  for (const [key, label, min, max, step, unit] of [
    ["angle", "Angle", -25, 25, 1, "°"],
    ["speed", "Speed", 4.5, 6.2, 0.05, ""],
    ["pitch", "3D Pitch", -25, 25, 1, "°"],
    ["phase", "Titan φ", 0, 140, 1, "°"],
  ]) {
    const wrap = document.createElement("label");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:2px;font-size:10px;color:#b8b29b;";
    const head = document.createElement("span");
    head.style.cssText = "display:flex;justify-content:space-between;";
    const valSpan = document.createElement("strong");
    valSpan.style.color = "#f4edc4";
    valSpan.textContent = `${params[key]}${unit}`;
    head.append(document.createTextNode(label), valSpan);

    const input = document.createElement("input");
    input.type = "range"; input.min = String(min); input.max = String(max);
    input.step = String(step); input.value = String(params[key]);
    input.style.cssText = "width:100%;height:14px;accent-color:#e2d898;margin:0;cursor:pointer;";
    input.addEventListener("input", () => {
      playing = true;
      params[key] = parseFloat(input.value);
      valSpan.textContent = `${params[key].toFixed(step < 1 ? 2 : 0)}${unit}`;
      inputState.adjust = true;
    }, { signal });
    wrap.append(head, input);
    sliderRow.append(wrap);
    sliderRefs[key] = { input, valSpan, unit, step };
  }

  function syncSliders() {
    for (const [k, ref] of Object.entries(sliderRefs)) {
      ref.input.value = String(params[k]);
      ref.valSpan.textContent = `${params[k].toFixed(ref.step < 1 ? 2 : 0)}${ref.unit}`;
    }
  }

  function makeBtn(label, key, mode = "pulse", accent = false) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.textContent = label; btn.dataset.control = key;
    btn.style.cssText =
      "padding:4px 8px;font:600 11px/1 'IBM Plex Mono',monospace;border-radius:4px;cursor:pointer;touch-action:none;" +
      (accent ? "background:#e2d898;color:#0d0f0a;border:1px solid #f4edc4;"
              : "background:#151912;color:#eae4d3;border:1px solid rgba(226,216,152,0.28);");
    if (mode === "hold") {
      let pointerUsed = false;
      const down = (e) => {
        e.preventDefault(); pointerUsed = true; playing = true;
        inputState[key] = true; canvas.focus({ preventScroll: true });
      };
      const up = () => { inputState[key] = false; };
      btn.addEventListener("pointerdown", down, { signal });
      btn.addEventListener("pointerup", up, { signal });
      btn.addEventListener("pointerleave", up, { signal });
      btn.addEventListener("pointercancel", up, { signal });
      btn.addEventListener("click", () => {
        playing = true;
        if (pointerUsed) { pointerUsed = false; return; }
        inputState[key] = true;
        const id = setTimeout(() => { timers.delete(id); inputState[key] = false; }, 220);
        timers.add(id);
      }, { signal });
    } else {
      btn.addEventListener("click", () => { playing = true; inputState[key] = true; }, { signal });
    }
    return btn;
  }

  const presetBtns = [
    makeBtn("1 Slingshot", "preset1"), makeBtn("2 Polar", "preset2"), makeBtn("3 Brake", "preset3"),
  ];
  presetWrap.append(...presetBtns);
  topBar.append(hudStatus, presetWrap);

  const btnFollow = document.createElement("button");
  btnFollow.type = "button";
  btnFollow.textContent = "◎ Orbit Saturn";
  btnFollow.style.cssText =
    "padding:4px 8px;font:600 11px/1 'IBM Plex Mono',monospace;border-radius:4px;" +
    "cursor:pointer;background:#151912;color:#a9d1be;border:1px solid rgba(169,209,190,0.34);";
  btnFollow.addEventListener("click", () => {
    followShip = !followShip;
    btnFollow.textContent = followShip ? "◎ Follow Probe" : "◎ Orbit Saturn";
  }, { signal });

  buttonRow.append(
    makeBtn("▶ Launch", "launch", "pulse", true),
    makeBtn("▲ Burn +Δv", "burn", "hold"),
    makeBtn("◀ Retro -Δv", "retro", "hold"),
    makeBtn("↻ Plan", "restart", "pulse"),
    btnFollow
  );
  if (prefersReduced) {
    const playBtn = document.createElement("button");
    playBtn.type = "button"; playBtn.textContent = "▶ Play";
    playBtn.style.cssText =
      "padding:4px 8px;font:600 11px/1 'IBM Plex Mono',monospace;border-radius:4px;" +
      "cursor:pointer;background:#a9d1be;color:#0d0f0a;border:1px solid #c9d9cc;";
    playBtn.addEventListener("click", () => { playing = true; playBtn.remove(); }, { signal });
    buttonRow.prepend(playBtn);
  }

  controlsPanel.append(sliderRow, buttonRow);
  root.prepend(topBar);
  root.append(noteLine, controlsPanel);

  const HOLD_KEYS = { Space: "burn", ShiftLeft: "retro", ShiftRight: "retro", KeyQ: "up", KeyE: "down" };
  const PULSE_KEYS = { Enter: "launch", KeyR: "restart", Digit1: "preset1", Digit2: "preset2", Digit3: "preset3" };
  const clearHoldKeys = () => { inputState.burn = inputState.retro = inputState.up = inputState.down = false; };

  window.addEventListener("keydown", (e) => {
    if (HOLD_KEYS[e.code]) { e.preventDefault(); playing = true; inputState[HOLD_KEYS[e.code]] = true; }
    else if (PULSE_KEYS[e.code]) { e.preventDefault(); playing = true; inputState[PULSE_KEYS[e.code]] = true; }
  }, { signal });
  window.addEventListener("keyup", (e) => {
    if (HOLD_KEYS[e.code]) { e.preventDefault(); inputState[HOLD_KEYS[e.code]] = false; }
  }, { signal });
  window.addEventListener("blur", clearHoldKeys, { signal });
  document.addEventListener("visibilitychange", () => { if (document.hidden) clearHoldKeys(); }, { signal });

  const disposables = [];
  const track = (item) => { disposables.push(item); return item; };
  let renderer = null, scene = null, camera = null;
  let saturnGroup = null, titanGroup = null, titanHaloMat = null;
  let shipGroup = null, plumeMesh = null, gateGroup = null;
  let trailPositions = null, trailColors = null, trailGeom = null, trailCount = 0;
  let predPositions = null, predGeom = null;
  const lastShipPos = new THREE.Vector3(5.2, 0, 0);
  let lastDv = 0, haloPulse = 0, gatePulse = 0, gateBaseScale = 1.0;

  const camOrbit = {
    yaw: 0.72, pitch: 0.56, dist: 27.5,
    target: DEFAULT_TARGET.clone(), dragging: false, px: 0, py: 0,
  };

  function updateCamera() {
    if (!camera) return;
    camOrbit.target.lerp(followShip && shipGroup ? shipGroup.position : DEFAULT_TARGET, 0.08);
    const cp = Math.cos(camOrbit.pitch);
    camera.position.set(
      camOrbit.target.x + camOrbit.dist * cp * Math.sin(camOrbit.yaw),
      camOrbit.target.y + camOrbit.dist * Math.sin(camOrbit.pitch),
      camOrbit.target.z + camOrbit.dist * cp * Math.cos(camOrbit.yaw)
    );
    camera.lookAt(camOrbit.target);
  }

  canvas.addEventListener("pointerdown", (e) => {
    playing = true; canvas.focus({ preventScroll: true });
    camOrbit.dragging = true; camOrbit.px = e.clientX; camOrbit.py = e.clientY;
    canvas.style.cursor = "grabbing"; canvas.setPointerCapture?.(e.pointerId);
  }, { signal });
  canvas.addEventListener("pointermove", (e) => {
    if (!camOrbit.dragging) return;
    camOrbit.yaw -= (e.clientX - camOrbit.px) * 0.008;
    camOrbit.pitch = Math.max(-1.35, Math.min(1.35, camOrbit.pitch + (e.clientY - camOrbit.py) * 0.008));
    camOrbit.px = e.clientX; camOrbit.py = e.clientY;
  }, { signal });
  const endDrag = () => { camOrbit.dragging = false; canvas.style.cursor = "grab"; };
  canvas.addEventListener("pointerup", endDrag, { signal });
  canvas.addEventListener("pointercancel", endDrag, { signal });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    camOrbit.dist = Math.max(8, Math.min(58, camOrbit.dist * (1 + e.deltaY * 0.001)));
  }, { signal, passive: false });

  // Clean up timers, DOM chrome, and every Three.js GPU resource on abort.
  signal.addEventListener("abort", () => {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    topBar.remove(); noteLine.remove(); controlsPanel.remove();
    for (const item of disposables) { try { item.dispose?.(); } catch {} }
    disposables.length = 0;
    if (renderer) { try { renderer.dispose(); } catch {} renderer = null; }
  }, { once: true });

  return {
    scene_init() {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(640, 400, false);
      renderer.setClearColor(0x060807, 1);

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(46, 640 / 400, 0.1, 260);
      updateCamera();

      scene.add(new THREE.AmbientLight(0x4b4638, 1.15));
      const sun = new THREE.DirectionalLight(0xfff4d6, 2.3);
      sun.position.set(34, 24, 26); scene.add(sun);
      const fill = new THREE.DirectionalLight(0x6e8599, 0.45);
      fill.position.set(-22, -14, -20); scene.add(fill);

      // Uniformly scattered observatory starfield (hash-based, zero spiral bands).
      const starCount = 460;
      const starPos = new Float32Array(starCount * 3);
      for (let i = 0; i < starCount; i++) {
        const theta = hash01(i * 3 + 1) * Math.PI * 2;
        const u = hash01(i * 3 + 2) * 2 - 1;
        const r = 85 + hash01(i * 3 + 3) * 45;
        const s = Math.sqrt(Math.max(0, 1 - u * u));
        starPos[i * 3] = r * s * Math.cos(theta);
        starPos[i * 3 + 1] = r * u;
        starPos[i * 3 + 2] = r * s * Math.sin(theta);
      }
      const starGeom = track(new THREE.BufferGeometry());
      starGeom.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
      scene.add(new THREE.Points(starGeom, track(new THREE.PointsMaterial({ color: 0xeae4d3, size: 0.42, transparent: true, opacity: 0.72 }))));

      // Saturn + radial translucent rings.
      saturnGroup = new THREE.Group();
      saturnGroup.add(new THREE.Mesh(
        track(new THREE.SphereGeometry(1.85, 36, 24)),
        track(new THREE.MeshStandardMaterial({ map: track(createSaturnTexture()), roughness: 0.85, metalness: 0.05 }))
      ));
      const rings = new THREE.Mesh(
        track(createRadialRingGeometry(2.3, 4.7, 72)),
        track(new THREE.MeshBasicMaterial({ map: track(createRingTexture()), side: THREE.DoubleSide, transparent: true, depthWrite: false }))
      );
      rings.rotation.x = Math.PI / 2;
      saturnGroup.add(rings);
      scene.add(saturnGroup);

      // Titan orbital track + Titan globe with golden tholin halo.
      const trackPts = Array.from({ length: 96 }, (_, i) => {
        const a = (i / 96) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * 10, 0, Math.sin(a) * 10);
      });
      scene.add(new THREE.LineLoop(
        track(new THREE.BufferGeometry().setFromPoints(trackPts)),
        track(new THREE.LineBasicMaterial({ color: 0xb9ad6b, transparent: true, opacity: 0.28 }))
      ));

      titanGroup = new THREE.Group();
      titanGroup.add(new THREE.Mesh(
        track(new THREE.SphereGeometry(0.55, 24, 18)),
        track(new THREE.MeshStandardMaterial({ map: track(createTitanTexture()), roughness: 0.75, emissive: 0x3b2206, emissiveIntensity: 0.35 }))
      ));
      titanHaloMat = track(new THREE.MeshBasicMaterial({ color: 0xe6a645, transparent: true, opacity: 0.28, side: THREE.BackSide }));
      titanGroup.add(new THREE.Mesh(track(new THREE.SphereGeometry(0.78, 20, 16)), titanHaloMat));
      scene.add(titanGroup);

      // Miniature Cassini spacecraft (gold bus + parabolic HGA dish + boom + plume).
      shipGroup = new THREE.Group();
      const bus = new THREE.Mesh(
        track(new THREE.CylinderGeometry(0.14, 0.16, 0.36, 8)),
        track(new THREE.MeshStandardMaterial({ color: 0xe2d898, metalness: 0.65, roughness: 0.3, emissive: 0x3d3418 }))
      );
      bus.rotation.x = Math.PI / 2; shipGroup.add(bus);
      const dish = new THREE.Mesh(
        track(new THREE.ConeGeometry(0.24, 0.12, 14, 1, true)),
        track(new THREE.MeshStandardMaterial({ color: 0xf4edc4, side: THREE.DoubleSide, roughness: 0.4 }))
      );
      dish.rotation.x = -Math.PI / 2; dish.position.z = 0.22; shipGroup.add(dish);
      const boom = new THREE.Mesh(
        track(new THREE.CylinderGeometry(0.018, 0.018, 0.65, 6)),
        track(new THREE.MeshBasicMaterial({ color: 0xb8b29b }))
      );
      boom.rotation.z = Math.PI / 2; boom.position.x = 0.32; shipGroup.add(boom);
      plumeMesh = new THREE.Mesh(
        track(new THREE.ConeGeometry(0.14, 0.58, 10)),
        track(new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.9 }))
      );
      plumeMesh.rotation.x = -Math.PI / 2; plumeMesh.position.z = -0.45; plumeMesh.visible = false;
      shipGroup.add(plumeMesh);
      scene.add(shipGroup);

      // 3D Target Beacon Gate.
      gateGroup = new THREE.Group();
      gateGroup.add(new THREE.Mesh(
        track(new THREE.TorusGeometry(1.45, 0.08, 12, 36)),
        track(new THREE.MeshBasicMaterial({ color: 0xa9d1be, transparent: true, opacity: 0.88 }))
      ));
      gateGroup.add(new THREE.Mesh(
        track(new THREE.TorusGeometry(1.05, 0.03, 8, 28)),
        track(new THREE.MeshBasicMaterial({ color: 0xf4edc4, transparent: true, opacity: 0.45 }))
      ));
      scene.add(gateGroup);

      // Pre-allocated live trajectory ribbon & predicted path (zero per-frame allocs).
      trailPositions = new Float32Array(MAX_TRAIL_POINTS * 3);
      trailColors = new Float32Array(MAX_TRAIL_POINTS * 3);
      trailGeom = track(new THREE.BufferGeometry());
      trailGeom.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
      trailGeom.setAttribute("color", new THREE.BufferAttribute(trailColors, 3));
      trailGeom.setDrawRange(0, 0);
      scene.add(new THREE.Line(trailGeom, track(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }))));

      predPositions = new Float32Array(MAX_PRED_POINTS * 3);
      predGeom = track(new THREE.BufferGeometry());
      predGeom.setAttribute("position", new THREE.BufferAttribute(predPositions, 3));
      predGeom.setDrawRange(0, 0);
      scene.add(new THREE.Line(predGeom, track(new THREE.LineBasicMaterial({ color: 0x9ab3a0, transparent: true, opacity: 0.48 }))));
    },

    scene_pose(sx, sy, sz, tx, ty, tz, px, py, pz) {
      if (!saturnGroup) return;
      saturnGroup.position.set(sx, sy, sz); saturnGroup.rotation.y += 0.002;
      titanGroup.position.set(tx, ty, tz); titanGroup.rotation.y += 0.008;
      const dx = px - lastShipPos.x, dy = py - lastShipPos.y, dz = pz - lastShipPos.z;
      shipGroup.position.set(px, py, pz);
      if (dx * dx + dy * dy + dz * dz > 1e-6) shipGroup.lookAt(px + dx, py + dy, pz + dz);
      lastShipPos.set(px, py, pz);
      gateGroup.rotation.y += 0.015; gateGroup.rotation.x += 0.006;
    },

    trail_point(x, y, z) {
      if (!trailGeom) return;
      if (trailCount >= MAX_TRAIL_POINTS) {
        trailPositions.copyWithin(0, 3); trailColors.copyWithin(0, 3);
        trailCount = MAX_TRAIL_POINTS - 1;
      }
      const i3 = trailCount * 3;
      trailPositions[i3] = x; trailPositions[i3 + 1] = y; trailPositions[i3 + 2] = z;
      if (lastDv > 0.35) { trailColors[i3] = 0.66; trailColors[i3 + 1] = 0.85; trailColors[i3 + 2] = 0.76; }
      else if (lastDv < -0.25) { trailColors[i3] = 0.88; trailColors[i3 + 1] = 0.58; trailColors[i3 + 2] = 0.45; }
      else { trailColors[i3] = 0.89; trailColors[i3 + 1] = 0.84; trailColors[i3 + 2] = 0.59; }
      trailCount++;
      trailGeom.attributes.position.needsUpdate = true;
      trailGeom.attributes.color.needsUpdate = true;
      trailGeom.setDrawRange(0, trailCount);
    },

    scene_draw() {
      if (!renderer || !scene || !camera) return;
      if (haloPulse > 0) {
        haloPulse = Math.max(0, haloPulse - 0.03);
        titanHaloMat.opacity = 0.28 + haloPulse * 0.55;
      }
      if (gatePulse > 0) {
        gatePulse = Math.max(0, gatePulse - 0.025);
        const s = gateBaseScale * (1 + gatePulse * 0.35);
        gateGroup.scale.set(s, s, s);
      }
      updateCamera();
      renderer.render(scene, camera);
    },

    set_text(text) {
      hudStatus.textContent = text;
      canvas.setAttribute("aria-label", `3D Gravity Assist Simulator: ${text}`);
    },

    control(name) {
      const value = Boolean(inputState[name]);
      if (name === "launch" || name === "restart" || name === "adjust" ||
          name === "preset1" || name === "preset2" || name === "preset3") {
        inputState[name] = false;
      }
      return value;
    },

    on_frame() {
      return {
        kind: "listener",
        subscribe(emit) {
          let rafId = 0, active = true, last = performance.now(), sentInitial = false;
          const tick = (now) => {
            if (!active || signal.aborted) return;
            const dt = Math.max(0, (now - last) / 1000);
            last = now;
            if (playing) emit(dt);
            else if (!sentInitial) { sentInitial = true; emit(0); }
            if (active && !signal.aborted) rafId = requestAnimationFrame(tick);
          };
          rafId = requestAnimationFrame(tick);
          const unregister = () => {
            if (!active) return;
            active = false;
            if (rafId) cancelAnimationFrame(rafId);
            rafId = 0;
          };
          signal.addEventListener("abort", unregister, { once: true });
          return unregister;
        },
      };
    },

    configure_mission(presetId, name, goal, angleDeg, speed, pitchDeg, phaseDeg, gx, gy, gz, gateR) {
      params.angle = angleDeg; params.speed = speed; params.pitch = pitchDeg; params.phase = phaseDeg;
      syncSliders();
      presetBtns.forEach((b, idx) => {
        const active = idx + 1 === Number(presetId);
        b.style.background = active ? "#e2d898" : "#151912";
        b.style.color = active ? "#0d0f0a" : "#eae4d3";
      });
      if (gateGroup) {
        gateBaseScale = gateR / 1.45;
        gateGroup.position.set(gx, gy, gz);
        gateGroup.lookAt(0, 0, 0);
        gateGroup.scale.set(gateBaseScale, gateBaseScale, gateBaseScale);
      }
      noteText.textContent = `${name} · Target: ${goal}`;
    },

    set_prediction(coordsCsv) {
      if (!predGeom) return;
      const nums = coordsCsv.split(",").map(Number);
      const count = Math.min(MAX_PRED_POINTS, Math.floor(nums.length / 3));
      for (let i = 0; i < count * 3; i++) predPositions[i] = nums[i];
      predGeom.attributes.position.needsUpdate = true;
      predGeom.setDrawRange(0, count);
    },

    read_param(name) { return Number(params[name] ?? 0); },

    set_telemetry(_speed, dvGain, _titanDist, _fuel, _energy, burning, _phaseCode, best, note) {
      lastDv = dvGain;
      if (plumeMesh) {
        const b = Number(burning);
        plumeMesh.visible = b !== 0;
        plumeMesh.material.color.setHex(b < 0 ? 0xee8270 : 0xffb347);
      }
      bestBadge.textContent = `BEST ${Number(best)}`;
      if (note) noteText.textContent = note;
    },

    trigger_cue(kind) {
      if (kind === "launch" || kind === "plan" || kind === "reset") {
        trailCount = 0;
        if (trailGeom) trailGeom.setDrawRange(0, 0);
      } else if (kind === "assist") {
        haloPulse = 1.0;
      } else if (kind === "intercept") {
        gatePulse = 1.0;
      }
    },
  };
}

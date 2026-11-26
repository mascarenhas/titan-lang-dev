// Huygens Landing on Titan — Editable 2D pixel-art canvas bindings.
// Runs in the sandboxed preview iframe and exposes named bindings to `titan.browser`.
// Edit the palette, probe sprites, or sky bands below and press Run!

const VW = 320;
const VH = 200;

const SKY_BANDS = [
  [0, 28, "#0b0e12"], [28, 30, "#1c1514"], [58, 34, "#3d2214"],
  [92, 38, "#763f1c"], [130, 36, "#b66d2a"], [166, 34, "#dfaa58"],
];
const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

const PALETTE = {
  G: "#e2d898", L: "#f4edc4", B: "#9b874b", D: "#2c3138", S: "#a9d1be",
  O: "#d96c38", C: "#f2e5c6", W: "#fff7db", A: "#ffb347", R: "#d94e2a",
};
const PROBE_SPRITE = [
  "....GG....", "...GLLG...", "..GBGGBG..", ".GLLSSLLG.",
  "GDDDDDDDDG", ".DBBBBBBD.", "..D....D..", ".D......D.",
];
const CHUTE_SPRITE = [
  "....OOOOOO....", "..OOCCOOCCOO..", ".OCCOOCCOOCCO.",
  "OCCOOCCOOCCOOO", "OOCOOCCOOCCOOO",
];
const FLAMES = [
  ["..WW..", ".WAAW.", "..RR..", "..R..."],
  ["..WW..", ".WAAW.", ".ARRA.", "..R..."],
  [".WWWW.", ".AAAA.", "..RR..", "...R.."],
];

function drawSprite(ctx, rows, ox, oy) {
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const col = PALETTE[rows[r][c]];
      if (col) { ctx.fillStyle = col; ctx.fillRect(ox + c, oy + r, 1, 1); }
    }
  }
}

function buildSky() {
  const sky = document.createElement("canvas");
  sky.width = VW;
  sky.height = VH;
  const g = sky.getContext("2d");
  g.imageSmoothingEnabled = false;

  for (let i = 0; i < SKY_BANDS.length; i++) {
    const [y, h, color] = SKY_BANDS[i];
    g.fillStyle = color;
    g.fillRect(0, y, VW, h);
    if (i > 0) {
      const prev = SKY_BANDS[i - 1][2];
      for (let dy = 0; dy < 8; dy++) {
        const cut = Math.floor(((8 - dy) / 8) * 16);
        for (let x = 0; x < VW; x++) {
          if (BAYER4[dy & 3][x & 3] < cut) { g.fillStyle = prev; g.fillRect(x, y + dy, 1, 1); }
        }
      }
    }
  }

  for (const [sx, sy, c] of [[22, 22, "#f4edc4"], [98, 21, "#b8b29b"], [141, 24, "#f4edc4"],
      [188, 20, "#b8b29b"], [278, 26, "#f4edc4"], [44, 34, "#b8b29b"], [126, 36, "#b8b29b"]]) {
    g.fillStyle = c; g.fillRect(sx, sy, 1, 1);
  }

  // Pixel-art ringed Saturn glowing through Titan's golden tholin haze.
  const sx = 248, sy = 46;
  for (let a = Math.PI; a <= Math.PI * 2; a += 0.04) {
    g.fillStyle = "#8a6d3b";
    g.fillRect(Math.round(sx + Math.cos(a) * 34), Math.round(sy + Math.sin(a) * 7 - Math.cos(a) * 5), 2, 1);
  }
  for (let dy = -13; dy <= 13; dy++) {
    for (let dx = -13; dx <= 13; dx++) {
      if (dx * dx + dy * dy <= 169) {
        g.fillStyle = dx - dy * 0.4 > 5 ? "#6e4e2a" : (Math.abs(dy) === 3 || Math.abs(dy) === 7) ? "#c9a55b" : "#e2c77f";
        g.fillRect(sx + dx, sy + dy, 1, 1);
      }
    }
  }
  for (let a = 0; a <= Math.PI; a += 0.03) {
    g.fillStyle = "#e2d898";
    g.fillRect(Math.round(sx + Math.cos(a) * 34), Math.round(sy + Math.sin(a) * 7 - Math.cos(a) * 5), 2, 1);
  }

  // Two parallax silhouettes of distant water-ice highlands.
  for (const [col, pts] of [
    ["#2b1a12", [[0, 128], [32, 114], [64, 126], [104, 108], [148, 130], [188, 116], [228, 106], [272, 122], [320, 112]]],
    ["#3f2416", [[0, 146], [42, 134], [86, 148], [134, 138], [176, 152], [214, 132], [258, 148], [296, 134], [320, 142]]],
  ]) {
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, VH);
    for (const [px, py] of pts) g.lineTo(px, py);
    g.lineTo(VW, VH);
    g.closePath();
    g.fill();
  }
  return sky;
}

export default function createBindings(host) {
  const { root, canvas, signal } = host;

  const buffer = document.createElement("canvas");
  buffer.width = VW;
  buffer.height = VH;
  const ctx = buffer.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  canvas.width = 640;
  canvas.height = 400;
  canvas.tabIndex = 0;
  canvas.style.cssText =
    "display:block;width:100%;max-width:640px;aspect-ratio:16/10;margin:0 auto;" +
    "image-rendering:pixelated;image-rendering:crisp-edges;border-radius:6px;" +
    "border:1px solid rgba(226,216,152,0.22);background:#0b0e12;outline:none;cursor:pointer;";
  const displayCtx = canvas.getContext("2d");
  displayCtx.imageSmoothingEnabled = false;
  const skyCache = buildSky();

  root.style.cssText =
    "display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px;" +
    "background:#080a07;color:#eae4d3;font-family:'IBM Plex Mono',ui-monospace,monospace;" +
    "box-sizing:border-box;width:100%;user-select:none;";

  const hudEl = document.createElement("div");
  hudEl.setAttribute("role", "status");
  hudEl.setAttribute("aria-live", "polite");
  hudEl.style.cssText =
    "width:100%;max-width:640px;font-size:12px;line-height:1.4;color:#e2d898;background:#0f120d;" +
    "border:1px solid rgba(226,216,152,0.18);border-radius:5px;padding:5px 10px;" +
    "box-sizing:border-box;display:flex;justify-content:space-between;gap:8px;";
  const hudText = document.createElement("span");
  hudText.textContent = "HUYGENS DESCENT · TITAN";
  const keyHint = document.createElement("span");
  keyHint.style.color = "#97927b";
  keyHint.textContent = "A/D tilt · W/Space thrust · R reset";
  hudEl.append(hudText, keyHint);

  const controlsBar = document.createElement("div");
  controlsBar.style.cssText = "width:100%;max-width:640px;display:flex;flex-wrap:wrap;gap:6px;justify-content:center;";

  const state = { left: false, right: false, thrust: false, restart: false };
  const prefersReduced = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  let playing = !prefersReduced;
  const timers = new Set();

  function pulseBriefly(key, ms) {
    state[key] = true;
    const id = setTimeout(() => { timers.delete(id); state[key] = false; }, ms);
    timers.add(id);
  }

  function makeBtn(label, key, accent = false) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.dataset.control = key;
    btn.style.cssText =
      "padding:6px 12px;font:600 12px/1 'IBM Plex Mono',monospace;border-radius:5px;cursor:pointer;touch-action:none;" +
      (accent ? "background:#e2d898;color:#0d0f0a;border:1px solid #f4edc4;"
              : "background:#151912;color:#eae4d3;border:1px solid rgba(226,216,152,0.28);");
    if (key === "restart") {
      btn.addEventListener("click", () => {
        playing = true;
        state.restart = true;
        canvas.focus({ preventScroll: true });
      }, { signal });
      return btn;
    }
    let pointerUsed = false;
    const down = (e) => {
      e.preventDefault();
      pointerUsed = true;
      playing = true;
      state[key] = true;
      canvas.focus({ preventScroll: true });
    };
    const up = () => { state[key] = false; };
    btn.addEventListener("pointerdown", down, { signal });
    btn.addEventListener("pointerup", up, { signal });
    btn.addEventListener("pointerleave", up, { signal });
    btn.addEventListener("pointercancel", up, { signal });
    btn.addEventListener("click", () => {
      playing = true;
      if (pointerUsed) { pointerUsed = false; return; }
      pulseBriefly(key, 180);
    }, { signal });
    return btn;
  }

  controlsBar.append(
    makeBtn("◀ Tilt Left", "left"),
    makeBtn("▲ Retro / Cut Chute", "thrust", true),
    makeBtn("▶ Tilt Right", "right"),
    makeBtn("↻ New Drop", "restart")
  );
  if (prefersReduced) {
    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.textContent = "▶ Play";
    playBtn.style.cssText =
      "padding:6px 12px;font:600 12px/1 'IBM Plex Mono',monospace;border-radius:5px;" +
      "cursor:pointer;background:#a9d1be;color:#0d0f0a;border:1px solid #c9d9cc;";
    playBtn.addEventListener("click", () => { playing = true; playBtn.remove(); }, { signal });
    controlsBar.prepend(playBtn);
  }
  root.prepend(hudEl);
  root.append(controlsBar);

  canvas.addEventListener("pointerdown", () => { playing = true; canvas.focus({ preventScroll: true }); }, { signal });

  const KEY_MAP = { ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right",
    ArrowUp: "thrust", KeyW: "thrust", Space: "thrust", KeyR: "restart" };
  const clearInputs = () => { state.left = state.right = state.thrust = false; };

  window.addEventListener("keydown", (e) => {
    const k = KEY_MAP[e.code];
    if (!k) return;
    e.preventDefault(); playing = true; state[k] = true;
  }, { signal });
  window.addEventListener("keyup", (e) => {
    const k = KEY_MAP[e.code];
    if (!k || k === "restart") return;
    e.preventDefault(); state[k] = false;
  }, { signal });
  window.addEventListener("blur", clearInputs, { signal });
  document.addEventListener("visibilitychange", () => { if (document.hidden) clearInputs(); }, { signal });

  // Clean up timers and mounted DOM chrome on Stop / re-Run.
  signal.addEventListener("abort", () => {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    hudEl.remove();
    controlsBar.remove();
  }, { once: true });

  let heights = [], pads = [], lakes = [];
  const particles = [];
  const motes = Array.from({ length: 22 }, (_, i) => ({ x: (i * 37) % VW, y: 24 + ((i * 23) % 130), s: 0.4 + (i % 3) * 0.25 }));
  let detachedChute = null;
  let frameCount = 0;
  let presentQueued = false;

  // Coalesce standalone primitive draws into a single nearest-neighbor blit per frame.
  function schedulePresent() {
    if (presentQueued) return;
    presentQueued = true;
    queueMicrotask(() => {
      presentQueued = false;
      if (signal.aborted) return;
      displayCtx.imageSmoothingEnabled = false;
      displayCtx.drawImage(buffer, 0, 0, VW, VH, 0, 0, canvas.width, canvas.height);
    });
  }

  function addParticle(x, y, vx, vy, color, life, size = 1) {
    if (particles.length > 220) particles.shift();
    particles.push({ x, y, vx, vy, color, life, size });
  }

  return {
    clear(color) { ctx.fillStyle = color; ctx.fillRect(0, 0, VW, VH); schedulePresent(); },
    fill_rect(x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); schedulePresent(); },
    fill_circle(x, y, r, color) {
      ctx.fillStyle = color;
      const cx = Math.round(x), cy = Math.round(y), rr = Math.max(1, Math.round(r));
      for (let dy = -rr; dy <= rr; dy++) {
        for (let dx = -rr; dx <= rr; dx++) {
          if (dx * dx + dy * dy <= rr * rr) ctx.fillRect(cx + dx, cy + dy, 1, 1);
        }
      }
      schedulePresent();
    },
    fill_text(text, x, y, color) { ctx.fillStyle = color; ctx.font = "bold 7px monospace"; ctx.fillText(text, Math.round(x), Math.round(y)); schedulePresent(); },
    set_text(text) { hudText.textContent = text; canvas.setAttribute("aria-label", `Huygens Lander on Titan: ${text}`); },
    control(name) {
      const pressed = Boolean(state[name]);
      if (name === "restart") state.restart = false;
      return pressed;
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

    set_terrain(heightsCsv, padsCsv, lakesCsv) {
      heights = heightsCsv.split(",").map(Number);
      pads = padsCsv.split(";").filter(Boolean).map((row) => {
        const [name, x1, x2, y, mult] = row.split(",");
        return { name, x1: +x1, x2: +x2, y: +y, mult: +mult };
      });
      lakes = lakesCsv.split(";").filter(Boolean).map((row) => {
        const [name, x1, x2, y] = row.split(",");
        return { name, x1: +x1, x2: +x2, y: +y };
      });
    },

    spawn_fx(kind, x, y, vx, vy) {
      if (kind === "reset") { particles.length = 0; detachedChute = null; return; }
      if (kind === "chute_cut") {
        detachedChute = { x, y: y - 14, vx: vx * 0.4 + 4, vy: -8, life: 3.5 };
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          addParticle(x, y - 4, Math.cos(a) * 18, Math.sin(a) * 18 - 6, "#f4edc4", 0.55);
        }
      } else if (kind === "splash") {
        for (let i = 0; i < 28; i++) {
          const a = -Math.PI * 0.1 - Math.random() * Math.PI * 0.8, spd = 14 + Math.random() * 34;
          addParticle(x, y + 4, Math.cos(a) * spd, Math.sin(a) * spd, i % 2 ? "#a9d1be" : "#4ca6b8", 0.9, 2);
        }
      } else if (kind === "crash") {
        const cols = ["#fff7db", "#ffb347", "#d94e2a", "#e2d898"];
        for (let i = 0; i < 36; i++) {
          const a = Math.random() * Math.PI * 2, spd = 10 + Math.random() * 44;
          addParticle(x, y, Math.cos(a) * spd, Math.sin(a) * spd - 12, cols[i & 3], 1.1, i % 3 ? 1 : 2);
        }
      } else if (kind === "touchdown") {
        for (let i = 0; i < 18; i++) {
          const dir = i % 2 ? -1 : 1;
          addParticle(x + dir * 4, y + 6, dir * (8 + Math.random() * 20), -4 - Math.random() * 10, "#e2c77f", 0.7);
        }
      }
    },

    draw_world(wind, elapsed) {
      frameCount++;
      ctx.drawImage(skyCache, 0, 0);

      ctx.fillStyle = "rgba(244, 237, 196, 0.32)";
      for (const m of motes) {
        m.x = (m.x + (wind * 0.03 + 0.12) * m.s + VW) % VW;
        ctx.fillRect(Math.round(m.x), Math.round(m.y), 2, 1);
      }

      if (heights.length > 1) {
        ctx.fillStyle = "#241814";
        ctx.beginPath();
        ctx.moveTo(0, VH);
        for (let i = 0; i < heights.length; i++) ctx.lineTo(i * 10, heights[i]);
        ctx.lineTo(VW, VH);
        ctx.closePath();
        ctx.fill();
        for (let i = 0; i < heights.length - 1; i++) {
          const x0 = i * 10, y0 = heights[i], y1 = heights[i + 1];
          for (let dx = 0; dx < 10; dx++) {
            const py = Math.round(y0 + ((y1 - y0) * dx) / 10);
            ctx.fillStyle = "#7a4d2c"; ctx.fillRect(x0 + dx, py, 1, 2);
            ctx.fillStyle = "#3a251c"; ctx.fillRect(x0 + dx, py + 2, 1, 3);
          }
        }
      }

      for (const lake of lakes) {
        const w = lake.x2 - lake.x1;
        ctx.fillStyle = "#0b222a"; ctx.fillRect(lake.x1, lake.y, w, VH - lake.y);
        ctx.fillStyle = "#194857"; ctx.fillRect(lake.x1, lake.y, w, 2);
        for (let rx = lake.x1 + 2; rx < lake.x2 - 3; rx += 6) {
          const shift = Math.floor(Math.sin(elapsed * 3.0 + rx * 0.3) * 2);
          ctx.fillStyle = (rx + Math.floor(elapsed * 4)) % 12 < 6 ? "#5fa6b5" : "#2d6d7c";
          ctx.fillRect(rx + shift, lake.y + 1 + ((rx / 6) % 2), 3, 1);
        }
      }

      const blink = Math.floor(elapsed * 3) % 2 === 0;
      ctx.font = "bold 6px monospace";
      for (const pad of pads) {
        const w = pad.x2 - pad.x1;
        ctx.fillStyle = "#5c5749"; ctx.fillRect(pad.x1, pad.y - 1, w, 3);
        ctx.fillStyle = "#e2d898"; ctx.fillRect(pad.x1 + 2, pad.y - 1, w - 4, 1);
        ctx.fillStyle = blink ? "#a9d1be" : "#e2d898";
        ctx.fillRect(pad.x1, pad.y - 3, 2, 2);
        ctx.fillRect(pad.x2 - 2, pad.y - 3, 2, 2);
        const tag = `${pad.name} ${pad.mult}x`;
        const tx = Math.min(VW - tag.length * 4 - 4, Math.max(4, Math.round(pad.x1 + (w - tag.length * 3.6) / 2)));
        ctx.fillStyle = "#f4edc4";
        ctx.fillText(tag, tx, pad.y + 10);
      }
    },

    draw_probe(x, y, vx, vy, angle, fuel, wind, alt, phaseCode, canopy, thrusting, rcs, best, drop, banner) {
      const dt = 1 / 60;
      // Titan integers arrive as JS BigInt; convert once for numeric comparisons.
      const phase = Number(phaseCode);
      const rcsDir = Number(rcs);

      if (thrusting) {
        const sinA = Math.sin(angle), cosA = Math.cos(angle);
        for (let i = 0; i < 2; i++) {
          addParticle(x - sinA * 6, y + cosA * 6, vx - sinA * 46 + (Math.random() - 0.5) * 14,
            vy + cosA * 46 + Math.random() * 10, i ? "#d94e2a" : "#ffb347", 0.35 + Math.random() * 0.2);
        }
        if (alt < 26) {
          addParticle(x + (Math.random() - 0.5) * 10, y + alt + 5,
            (Math.random() - 0.5) * 32, -6 - Math.random() * 10, "#c98e46", 0.45);
        }
      }
      if (rcsDir !== 0 && phase === 1) {
        addParticle(x - rcsDir * 5, y - 1, vx - rcsDir * 22, vy + (Math.random() - 0.5) * 8, "#c9d9cc", 0.22);
      }
      if (detachedChute) {
        detachedChute.life -= dt;
        detachedChute.x += (detachedChute.vx + wind * 0.5) * dt;
        detachedChute.y += detachedChute.vy * dt;
        detachedChute.vy += 4 * dt;
        if (detachedChute.life > 0) drawSprite(ctx, CHUTE_SPRITE, Math.round(detachedChute.x - 7), Math.round(detachedChute.y - 3));
        else detachedChute = null;
      }
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 12 * dt;
        ctx.fillStyle = p.color; ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
      }

      const px = Math.round(x), py = Math.round(y);
      if (phase !== 3) {
        if (phase === 0) {
          const cx = px + Math.round(canopy * 26), cy = py - 18;
          ctx.strokeStyle = "#b8b29b"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(px - 3, py - 2); ctx.lineTo(cx - 5, cy + 4);
          ctx.moveTo(px + 3, py - 2); ctx.lineTo(cx + 5, cy + 4); ctx.stroke();
          drawSprite(ctx, CHUTE_SPRITE, cx - 7, cy);
        }
        ctx.save(); ctx.translate(px, py); ctx.rotate(angle);
        drawSprite(ctx, PROBE_SPRITE, -5, -4);
        if (thrusting) drawSprite(ctx, FLAMES[(frameCount >> 1) % FLAMES.length], -3, 4);
        ctx.restore();
        if (phase === 2 && frameCount % 36 < 20) {
          ctx.fillStyle = "#a9d1be"; ctx.fillRect(px, py - 8, 1, 4);
          ctx.fillStyle = "#f4edc4"; ctx.fillRect(px - 1, py - 9, 3, 1);
        }
      } else {
        ctx.fillStyle = "#9b874b"; ctx.fillRect(px - 4, py + 3, 3, 2);
        ctx.fillStyle = "#e2d898"; ctx.fillRect(px + 1, py + 4, 4, 2);
        ctx.fillStyle = "#2c3138"; ctx.fillRect(px - 1, py + 2, 2, 3);
      }

      ctx.fillStyle = "rgba(8, 10, 7, 0.78)"; ctx.fillRect(0, 0, VW, 17);
      ctx.fillStyle = "rgba(226, 216, 152, 0.25)"; ctx.fillRect(0, 17, VW, 1);
      ctx.font = "bold 7px monospace";
      ctx.fillStyle = "#f4edc4"; ctx.fillText(`ALT ${Math.round(alt * 4)}m`, 15, 11);
      ctx.fillStyle = vy > 20 ? "#ee8270" : vy > 15 ? "#dfb468" : "#a9d1be";
      ctx.fillText(`VY ${(vy * 0.3).toFixed(1)}`, 72, 11);
      ctx.fillStyle = "#b8b29b"; ctx.fillText(`WIND ${wind >= 0 ? "+" : ""}${(wind * 0.4).toFixed(1)}`, 122, 11);
      ctx.fillStyle = "#eae4d3"; ctx.fillText("FUEL", 184, 11);
      ctx.fillStyle = "#232820"; ctx.fillRect(208, 5, 44, 6);
      ctx.fillStyle = fuel < 25 ? "#ee8270" : "#e2d898";
      ctx.fillRect(209, 6, Math.round((Math.max(0, fuel) / 100) * 42), 4);
      ctx.fillStyle = "#a9d1be"; ctx.fillText(`BEST ${Number(best)}`, 262, 11);

      if (phase >= 2) {
        ctx.fillStyle = "rgba(8, 10, 7, 0.84)"; ctx.fillRect(24, 52, VW - 48, 28);
        ctx.strokeStyle = phase === 2 ? "#a9d1be" : "#ee8270";
        ctx.strokeRect(24.5, 52.5, VW - 49, 27);
        ctx.fillStyle = phase === 2 ? "#a9d1be" : "#ee8270";
        ctx.fillText(banner, Math.max(30, Math.round((VW - banner.length * 4.2) / 2)), 69);
      } else {
        ctx.fillStyle = "rgba(244, 237, 196, 0.72)"; ctx.font = "bold 6px monospace";
        ctx.fillText(`DROP #${Number(drop)} · ${banner}`, 6, VH - 4);
      }
      schedulePresent();
    },
  };
}

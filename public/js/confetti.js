/* ==========================================================================
   Confetti — about 60 lines of canvas, no library.

   Kept deliberately cheap so it never competes with the live scoreboard:
   one canvas created on demand, a hard particle cap, a single rAF loop that
   stops itself and removes the canvas when the last piece falls off screen.
   Honours prefers-reduced-motion by not running at all.
   ========================================================================== */

const COLOURS = ["#00a950", "#f5831f", "#3fd9a4", "#e8c35c", "#f2622a", "#ffffff"];

const reduced = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

let canvas = null;
let ctx = null;
let pieces = [];
let raf = 0;

function ensureCanvas() {
  if (canvas) return canvas;
  canvas = document.createElement("canvas");
  canvas.className = "confetti-canvas";
  document.body.appendChild(canvas);
  ctx = canvas.getContext("2d");
  resize();
  window.addEventListener("resize", resize);
  return canvas;
}

function resize() {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function spawn(count, originY) {
  const w = window.innerWidth;
  for (let i = 0; i < count; i++) {
    pieces.push({
      x: w * (0.5 + (Math.random() - 0.5) * 0.7),
      y: window.innerHeight * originY,
      vx: (Math.random() - 0.5) * 7,
      vy: -Math.random() * 9 - 5,
      size: 5 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.28,
      colour: COLOURS[(Math.random() * COLOURS.length) | 0],
      life: 0,
    });
  }
}

function tick() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  const h = window.innerHeight;

  for (const p of pieces) {
    p.life++;
    p.vy += 0.28; // gravity
    p.vx *= 0.995; // drag
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = Math.max(0, 1 - p.life / 190);
    ctx.fillStyle = p.colour;
    ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    ctx.restore();
  }

  pieces = pieces.filter((p) => p.y < h + 40 && p.life < 190);

  if (pieces.length) {
    raf = requestAnimationFrame(tick);
  } else {
    stop();
  }
}

function stop() {
  cancelAnimationFrame(raf);
  raf = 0;
  window.removeEventListener("resize", resize);
  canvas?.remove();
  canvas = null;
  ctx = null;
}

/**
 * Fire the confetti.
 * @param {"sale"|"champion"} [scale] "champion" is the bigger, longer burst.
 */
export function celebrate(scale = "sale") {
  if (reduced()) return;
  ensureCanvas();
  const big = scale === "champion";
  spawn(big ? 90 : 55, big ? 0.55 : 0.6);
  if (big) setTimeout(() => pieces.length && spawn(60, 0.5), 260);
  if (!raf) raf = requestAnimationFrame(tick);
}

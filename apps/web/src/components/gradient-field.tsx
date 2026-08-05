"use client";

import { useEffect, useRef } from "react";

/**
 * Ribbon Field — animated canvas stripe gradient (21st.dev "Animated Gradient").
 *
 * A stripe field along `ANGLE`: each stripe is sized by its stop `pos`, edges are
 * feathered by `SOFTNESS`, and `WAVE` bends the bands with a cross-axis sine offset.
 * A CSS linear-gradient is only exact when wave is 0 — it isn't here, so this renders
 * to canvas. The CSS mesh underneath stays as the first paint and the fallback.
 *
 * MOTION CONTRACT (the part that is easy to get wrong):
 *   ph   = t * SPEED            elapsed-seconds clock, t in seconds
 *   amt  = MOTION_AMOUNT        0 here — so the angle sway term evaluates to exactly 0
 *   spin = ph * DIR
 *   angle = ANGLE + sin(spin * 0.6) * 28 * amt      hard bands sway, never spin
 *   clock = WAVE_CLOCK0 + ph * 1.2                  the curved field's own wave clock
 * Every modulation is written so it is exactly 0 at ph = 0 (sin(0) = 0), otherwise the
 * gradient visibly snaps the moment the loop starts. Nothing animated is quantised —
 * no rounding of angle, centre or stop positions, because per-frame rounding is
 * precisely what makes this kind of motion step instead of glide.
 *
 * PERFORMANCE. The field is smooth, so it is rasterised into a small offscreen buffer
 * and upscaled — a full-resolution per-pixel loop every frame would burn a phone's
 * battery for no visible gain. Grain is left to the CSS layer above (a bitmap overlay)
 * rather than baked per-pixel here, which keeps the buffer cheap.
 *
 * The loop stops when the tab is hidden, and `prefers-reduced-motion` paints exactly one
 * frame at ph = 0 and never starts a loop at all.
 */

const ANGLE = 38;            // degrees
const CENTER_X = 0.5;
const CENTER_Y = 0.5;
const SCALE = 0.68;          // scale: 68
const SOFTNESS = 0.24;       // softness: 24
const WAVE = 0.14;           // wave: 14
const DISTORTION = 0.28;     // distortion: 28
const SPEED = 1.0;           // speed: 100
const MOTION_AMOUNT = 0.0;   // motionAmount: 0 -> the sway term is identically zero
const DIR = 1;               // motionReverse: false
const WAVE_CLOCK0 = 20.75;

/** Palette — pos is the stop position along the gradient axis, 0..1. */
const STOPS: { pos: number; r: number; g: number; b: number }[] = [
  { pos: 0.18, r: 255, g: 255, b: 255 }, // White
  { pos: 0.57, r: 120, g: 184, b: 249 }, // Sky blue
  { pos: 0.6, r: 86, g: 103, b: 255 },   // Ultramarine
  { pos: 1.0, r: 77, g: 47, b: 249 },    // Iris
];

const TAU = Math.PI * 2;
/** Buffer width in px. The field has no high-frequency detail, so this upscales cleanly. */
const BUF_W = 190;

/**
 * Band boundaries sit at the midpoint between consecutive stops, and each boundary is
 * feathered proportionally to the gap it divides. Vendor's published CSS approximation
 * agrees on the widest transition (softness 0.24 x gap 0.39 x 0.5 = 4.68%, matching its
 * 33.18%->37.86%) and drifts on the narrow ones — that snippet is self-described as an
 * approximation, so the consistent rule is used here rather than its per-stop constants.
 */
const BOUNDS = STOPS.slice(0, -1).map((s, i) => {
  const next = STOPS[i + 1];
  const gap = next.pos - s.pos;
  return { at: (s.pos + next.pos) / 2, half: Math.max((SOFTNESS * gap) / 4, 0.0015) };
});

function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function GradientField({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const buf = document.createElement("canvas");
    const bctx = buf.getContext("2d", { alpha: false });
    if (!bctx) return;

    let raf = 0;
    let start = 0;
    let bw = 0;
    let bh = 0;
    let img: ImageData | null = null;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    function resize() {
      const r = canvas!.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.round(r.width * dpr);
      canvas!.height = Math.round(r.height * dpr);
      bw = BUF_W;
      bh = Math.max(2, Math.round((BUF_W * r.height) / r.width));
      buf.width = bw;
      buf.height = bh;
      img = bctx!.createImageData(bw, bh);
    }

    function render(ph: number) {
      if (!img) return;
      // Motion terms — both exactly 0-valued at ph = 0.
      const spin = ph * DIR;
      const angle = ANGLE + Math.sin(spin * 0.6) * 28 * MOTION_AMOUNT;
      const clock = WAVE_CLOCK0 + ph * 1.2;

      const a = (angle * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const aspect = bw / bh;
      const data = img.data;

      for (let y = 0; y < bh; y++) {
        const ny = y / (bh - 1);
        const dy = ny - CENTER_Y;
        for (let x = 0; x < bw; x++) {
          const nx = x / (bw - 1);
          // Aspect-correct so the 38° reads as 38° on a tall panel, not a sheared angle.
          const dx = (nx - CENTER_X) * aspect;

          const along = dx * cos + dy * sin;   // gradient axis
          const cross = -dx * sin + dy * cos;  // perpendicular axis

          // Cross-axis sine bend — the "ribbon".
          let g = 0.5 + along / SCALE;
          g += WAVE * 0.35 * Math.sin(cross * 2.4 * TAU + clock);
          // Distortion: the vendor does not publish this term, so it is a documented
          // second harmonic — deliberately weak so it textures the ribbon edge without
          // competing with the specified wave above.
          g += DISTORTION * 0.045 * Math.sin(cross * 5.1 * TAU - clock * 0.6);

          // Resolve the stripe colour: flat bands, feathered at midpoint boundaries.
          let r = STOPS[0].r;
          let gg = STOPS[0].g;
          let b = STOPS[0].b;
          for (let i = 0; i < BOUNDS.length; i++) {
            const bd = BOUNDS[i];
            const m = smoothstep(bd.at - bd.half, bd.at + bd.half, g);
            if (m <= 0) break;
            const nxt = STOPS[i + 1];
            r += (nxt.r - r) * m;
            gg += (nxt.g - gg) * m;
            b += (nxt.b - b) * m;
          }

          const o = (y * bw + x) * 4;
          data[o] = r;
          data[o + 1] = gg;
          data[o + 2] = b;
          data[o + 3] = 255;
        }
      }

      bctx!.putImageData(img, 0, 0);
      ctx!.imageSmoothingEnabled = true;
      ctx!.imageSmoothingQuality = "high";
      ctx!.drawImage(buf, 0, 0, canvas!.width, canvas!.height);
    }

    function frame(now: number) {
      if (!start) start = now;
      const t = (now - start) / 1000;
      render(t * SPEED);
      raf = requestAnimationFrame(frame);
    }

    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    function begin() {
      stop();
      // Below `lg` the art panel is display:none, so the canvas measures 0 and `img` is
      // null. Starting a loop there would burn a frame budget on a surface nobody can
      // see — which matters on the phone this app is meant to survive on.
      if (!img) return;
      if (reduced.matches || document.hidden) {
        render(0); // single frame at ph = 0 — the exact un-animated state
        return;
      }
      start = 0;
      raf = requestAnimationFrame(frame);
    }

    // Re-entering begin() (not just re-rendering) means rotating a phone across the `lg`
    // breakpoint starts the animation that was correctly never started at mobile width.
    const onResize = () => {
      resize();
      begin();
    };

    resize();
    begin();

    const ro = new ResizeObserver(onResize);
    ro.observe(canvas);
    document.addEventListener("visibilitychange", begin);
    reduced.addEventListener("change", begin);

    return () => {
      stop();
      ro.disconnect();
      document.removeEventListener("visibilitychange", begin);
      reduced.removeEventListener("change", begin);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden />;
}

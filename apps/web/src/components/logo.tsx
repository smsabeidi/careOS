/** CareOS brand mark — an interlocked care cross.
 *  Two rounded limbs rotated 180° weave into a plus, the seam drawing an S through
 *  the center (care given / care received). Vector-native so it stays crisp from the
 *  16px favicon to hero size.
 *
 *  SURFACES. The default palette is tuned for DARK surfaces: the pale limb runs
 *  #dcebfb→#7fadf0, which is ~1.1:1 on white and effectively disappears there — only
 *  the blue limb survives and the weave reads as a half-drawn glyph. Pass `onLight`
 *  on white/near-white surfaces to swap that limb to a mid-blue ramp that holds its
 *  shape. The blue limb is unchanged either way, so the light/dark weave still reads.
 *
 *  WHY THE IDS ARE VARIANT-SCOPED. SVG ids are document-global, and every instance of
 *  this component emits its own <defs>. Two instances on one page therefore collide,
 *  and `url(#id)` resolves to whichever definition comes FIRST in document order — not
 *  the one inside the referencing SVG. That is only cosmetic while the definitions
 *  match, but it breaks outright when the first instance sits in a `display:none`
 *  subtree: a paint server in a hidden subtree paints nothing, so the visible logo
 *  renders with correct geometry and no colour. The sign-in page hits exactly that
 *  (an art-panel mark hidden below `lg`, plus a form-panel mark shown only below `lg`).
 *  Scoping the ids by variant means the two never reference each other's defs.
 */
export function BrandLogo({
  size = 30,
  onLight = false,
}: {
  size?: number;
  onLight?: boolean;
}) {
  const v = onLight ? "light" : "dark";
  const paleId = `cos-pale-${v}`;
  const blueId = `cos-blue-${v}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <linearGradient id={paleId} x1="70" y1="8" x2="16" y2="72" gradientUnits="userSpaceOnUse">
          {onLight ? (
            <>
              <stop offset="0" stopColor="#9cc4f5" />
              <stop offset="0.55" stopColor="#6ea6ee" />
              <stop offset="1" stopColor="#4a86dd" />
            </>
          ) : (
            <>
              <stop offset="0" stopColor="#dcebfb" />
              <stop offset="0.55" stopColor="#b3d1f7" />
              <stop offset="1" stopColor="#7fadf0" />
            </>
          )}
        </linearGradient>
        <linearGradient id={blueId} x1="112" y1="56" x2="58" y2="112" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#57a2ff" />
          <stop offset="0.5" stopColor="#1f7bfa" />
          <stop offset="1" stopColor="#0a55e6" />
        </linearGradient>
      </defs>
      {/* pale limb: top arm sweeping into the left arm */}
      <path
        d={"M 64 22 L 64 44 Q 64 64 44 64 L 22 64"}
        stroke={`url(#${paleId})`}
        strokeWidth="40"
        strokeLinecap="round"
      />
      {/* blue limb: bottom arm sweeping into the right arm (drawn over — the weave) */}
      <path
        d={"M 64 106 L 64 84 Q 64 64 84 64 L 106 64"}
        stroke={`url(#${blueId})`}
        strokeWidth="40"
        strokeLinecap="round"
      />
    </svg>
  );
}

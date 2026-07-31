/** CareOS brand mark — an interlocked care cross.
 *  Two rounded limbs rotated 180° weave into a plus, the seam drawing an S through
 *  the center (care given / care received). Vector-native so it stays crisp from the
 *  16px favicon to hero size. Works on light or dark surfaces (no baked background).
 */
export function BrandLogo({ size = 30 }: { size?: number }) {
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
        <linearGradient id="cos-light" x1="70" y1="8" x2="16" y2="72" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#dcebfb" />
          <stop offset="0.55" stopColor="#b3d1f7" />
          <stop offset="1" stopColor="#7fadf0" />
        </linearGradient>
        <linearGradient id="cos-blue" x1="112" y1="56" x2="58" y2="112" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#57a2ff" />
          <stop offset="0.5" stopColor="#1f7bfa" />
          <stop offset="1" stopColor="#0a55e6" />
        </linearGradient>
      </defs>
      {/* light limb: top arm sweeping into the left arm */}
      <path
        d="M 64 22 L 64 44 Q 64 64 44 64 L 22 64"
        stroke="url(#cos-light)"
        strokeWidth="40"
        strokeLinecap="round"
      />
      {/* blue limb: bottom arm sweeping into the right arm (drawn over — the weave) */}
      <path
        d="M 64 106 L 64 84 Q 64 64 84 64 L 106 64"
        stroke="url(#cos-blue)"
        strokeWidth="40"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** CareOS icon set — monoline, SF-Symbols-inspired: even optical weight, rounded
 *  terminals, currentColor, zero dependency. Default 18px on a 24 grid. */
import type { SVGProps } from "react";

function base(props: SVGProps<SVGSVGElement>) {
  return {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
}

export const IconUsers = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
export const IconClipboard = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="8" y="2" width="8" height="4" rx="1.4" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <path d="M9 12h6M9 16h4" />
  </svg>
);
export const IconShield = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);
export const IconActivity = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </svg>
);
export const IconHome = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m3 9.2 9-6.7 9 6.7V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    <path d="M9.2 22v-8.4h5.6V22" />
  </svg>
);
export const IconHeart = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M19 14c1.5-1.5 2-3.2 2-5a5 5 0 0 0-9-3 5 5 0 0 0-9 3c0 1.8.5 3.5 2 5l7 7Z" />
  </svg>
);
export const IconLogOut = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5M21 12H9" />
  </svg>
);
export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M20 6.5 9 17.5l-5-5" />
  </svg>
);
export const IconAlert = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </svg>
);
export const IconLock = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3.5" y="11" width="17" height="10.5" rx="2.6" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);
export const IconPen = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
);
export const IconHistory = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l3 3" />
  </svg>
);
export const IconChevronRight = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m9 18 6-6-6-6" />
  </svg>
);
export const IconChevronDown = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);
export const IconCalendar = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3" y="4.5" width="18" height="17" rx="2.6" />
    <path d="M16 2.5v4M8 2.5v4M3 10h18" />
  </svg>
);
export const IconSparkle = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 3c.4 3.4 2.1 5.1 5.5 5.5C14.1 8.9 12.4 10.6 12 14c-.4-3.4-2.1-5.1-5.5-5.5C9.9 8.1 11.6 6.4 12 3Z" />
    <path d="M19 14c.2 1.6 1 2.4 2.6 2.6-1.6.2-2.4 1-2.6 2.6-.2-1.6-1-2.4-2.6-2.6 1.6-.2 2.4-1 2.6-2.6Z" />
  </svg>
);
export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </svg>
);
export const IconBell = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M18 8a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14 18 8Z" />
    <path d="M10.3 20a2 2 0 0 0 3.4 0" />
  </svg>
);
export const IconX = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);
export const IconArrowRight = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M5 12h14M13 5l7 7-7 7" />
  </svg>
);
export const IconMapPin = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M20 10c0 5.5-8 12-8 12s-8-6.5-8-12a8 8 0 0 1 16 0Z" />
    <circle cx="12" cy="10" r="2.6" />
  </svg>
);
export const IconClock = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </svg>
);
export const IconInbox = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3 12h5l2 3h4l2-3h5" />
    <path d="M4.5 6.5 3 12v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6l-1.5-5.5A2 2 0 0 0 17.6 5H6.4a2 2 0 0 0-1.9 1.5Z" />
  </svg>
);
// Credentials — award rosette (license/certification)
export const IconBadge = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="9" r="6" />
    <path d="m8.5 13.5-1.5 7 5-3 5 3-1.5-7" />
    <path d="m9.5 9 1.7 1.7L15 7" />
  </svg>
);
// Compliance — clipboard with a check (distinct from IconClipboard's lines)
export const IconClipboardCheck = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="8" y="2" width="8" height="4" rx="1.4" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <path d="m9 14.5 2 2 4-4.5" />
  </svg>
);
// View-as / demo persona switcher
export const IconEye = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
// Metric trend deltas
export const IconArrowUpRight = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M7 17 17 7M8 7h9v9" />
  </svg>
);
export const IconArrowDownRight = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M7 7 17 17M17 8v9H8" />
  </svg>
);

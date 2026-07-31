import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

/* Inter — the single corporate face: UI, display titles, and tabular numerals.
   Loaded as the full variable axis (wght 100–900) plus opsz (optical sizing)
   for dense 13px tables. Self-hosted at build via next/font — no runtime CDN. */
const inter = Inter({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "CareOS", template: "%s · CareOS" },
  description: "Care operations, provably in order.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f2f2f7",
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}

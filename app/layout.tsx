import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Monitor Agents",
  description: "A multi-LLM agent topology and usage monitor.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "oklch(14.1% 0.005 285.823)",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

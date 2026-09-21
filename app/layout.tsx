import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DevinCast — Live Audio Commentary for Autonomous Agents",
  description: "Two-host sports commentary for a live coding session."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

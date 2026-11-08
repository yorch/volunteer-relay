import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Volunteer Relay",
  description:
    "Bring volunteer updates, community needs and contributions together.",
};

const dmSans = localFont({
  src: "./fonts/dm-sans/DMSans.ttf",
  variable: "--font-dm-sans",
  display: "swap",
});
const manrope = localFont({
  src: "./fonts/manrope/Manrope.ttf",
  variable: "--font-manrope",
  display: "swap",
});
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${dmSans.variable} ${manrope.variable}`}>
      <body>{children}</body>
    </html>
  );
}

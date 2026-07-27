import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.DF_DASHBOARD_ORIGIN ?? "http://127.0.0.1:3000"),
  title: {
    default: "Dark Factory Control Console",
    template: "%s · Dark Factory",
  },
  description:
    "Local campaign operations, evaluation evidence, and harness performance for Dark Factory.",
  openGraph: {
    title: "Dark Factory Control Console",
    description: "Local-first optimization campaign operations and evidence.",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Dark Factory Control Console",
    description: "Local-first optimization campaign operations and evidence.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "../components/AppShell";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "codex-clone",
  description: "Web-based AI agent coding app: isolated container workspaces, GitHub-backed, scheduled jobs.",
};

/**
 * Runs before first paint so the resolved theme is on <html> for the very first
 * frame. Without it the page renders light, then repaints dark, which is worse
 * than either theme. The value written is always concrete ("light" or "dark"),
 * so the `dark:` variant and the CSS tokens agree with each other.
 */
const THEME_SCRIPT = `
try {
  var stored = localStorage.getItem("codex-clone.theme");
  var system = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", stored === "light" || stored === "dark" ? stored : system);
} catch (_) {
  document.documentElement.setAttribute("data-theme", "light");
}`.trim();

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

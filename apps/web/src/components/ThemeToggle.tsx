"use client";

import { useEffect, useState } from "react";
import { cn } from "./ui/cn";

type Theme = "light" | "dark";

/**
 * Companion to the inline script in the layout: that script resolves the theme
 * before first paint, this only ever flips an already-resolved value. Reading
 * the attribute (rather than re-deriving the preference) keeps the two in step.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem("codex-clone.theme", next);
    } catch {
      // Private mode or a blocked storage partition: the toggle still works for
      // this session, it just will not be remembered.
    }
    setTheme(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md",
        "text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg",
      )}
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
          <circle cx="8" cy="8" r="3.1" fill="currentColor" />
          <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1" />
          </g>
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
          <path
            d="M13.4 9.6A5.8 5.8 0 0 1 6.4 2.6a5.8 5.8 0 1 0 7 7Z"
            fill="currentColor"
          />
        </svg>
      )}
    </button>
  );
}

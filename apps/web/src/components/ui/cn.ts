/** Minimal class joiner. Deliberately not `clsx` -- one function is not a dependency. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

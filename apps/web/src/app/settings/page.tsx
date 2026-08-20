import type { Metadata } from "next";

import { withConfig } from "@/app/api/_lib/settings-store";
import { SettingsForm } from "@/components/settings/settings-form";

/**
 * Settings.
 *
 * Rendered on the server so the credential hints come from the database
 * directly, with no client round trip and no window in which a mask is
 * missing. The full credentials are not read here at all — `store.view()`
 * works off the `*_hint` columns, so loading this page performs no decryption.
 */

export const runtime = "nodejs";
// Reads the database on every request; must never be prerendered at build time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Settings · codex-clone",
  description: "Credentials and defaults for the local agent runner.",
};

export default async function SettingsPage() {
  const result = await withConfig((store) => store.view());

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-2 text-sm text-black/60 dark:text-white/60">
          Credentials are encrypted with AES-256-GCM before they are stored, using the key in{" "}
          <code className="font-mono">APP_ENCRYPTION_KEY</code>. Only the last four characters ever leave the server, and
          no credential is ever passed into an agent container.
        </p>
      </header>

      {result.ok ? (
        <SettingsForm initial={result.value} />
      ) : (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-5">
          <h2 className="text-sm font-semibold text-red-800 dark:text-red-300">Settings are unavailable</h2>
          <p className="mt-2 text-sm text-red-800/90 dark:text-red-300/90">{result.problem.message}</p>
          <p className="mt-3 text-sm text-black/60 dark:text-white/60">
            Copy <code className="font-mono">.env.example</code> to <code className="font-mono">.env.local</code> at the
            repository root, generate an encryption key, then run{" "}
            <code className="font-mono">pnpm db:up &amp;&amp; pnpm db:migrate</code>.
          </p>
        </div>
      )}
    </main>
  );
}

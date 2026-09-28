import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProviderSlug } from "@/components/types";
import { providerLabel } from "@/lib/failure-reasons";
import { INFLIGHT_CAP_MAX, INFLIGHT_CAP_MIN, parseInflightCap } from "@/lib/inflight-caps";
import type { InflightCapView } from "@/server/api/settings";

/** Per provider; null or missing means nothing is typed or wrong there. */
type PerProvider = Partial<Record<ProviderSlug, string | null>>;

/**
 * The calls in flight section of Account settings: one field per provider,
 * saved and reset like the run size limit. A field whose environment variable
 * wins is read-only and names the variable, because a save there would not
 * change what the worker applies.
 *
 * The drafts live here and survive only a failed save, so what was typed is
 * not lost. The route owns the save itself and its toasts.
 */
export function InflightCapsSection({
  caps,
  readFailed,
  onCommit,
}: {
  /** Undefined while the caps are loading. */
  caps: InflightCapView[] | undefined;
  readFailed: boolean;
  /** Saves one cap, or clears it with null. Resolves true once saved. */
  onCommit: (provider: ProviderSlug, cap: number | null) => Promise<boolean>;
}) {
  const [drafts, setDrafts] = useState<PerProvider>({});
  const [errors, setErrors] = useState<PerProvider>({});
  const [saving, setSaving] = useState<ProviderSlug | null>(null);

  async function commit(provider: ProviderSlug, cap: number | null) {
    setSaving(provider);
    try {
      if (await onCommit(provider, cap)) {
        setDrafts((current) => ({ ...current, [provider]: null }));
        setErrors((current) => ({ ...current, [provider]: null }));
      }
    } finally {
      setSaving(null);
    }
  }

  function save(cap: InflightCapView) {
    const parsed = parseInflightCap(drafts[cap.provider] ?? String(cap.effective));
    if (parsed === null) {
      setErrors((current) => ({
        ...current,
        [cap.provider]: `Enter a whole number between ${INFLIGHT_CAP_MIN} and ${INFLIGHT_CAP_MAX}.`,
      }));
      return;
    }
    void commit(cap.provider, parsed);
  }

  return (
    <section className="space-y-3">
      <h2 className="type-section">Calls in flight</h2>
      <div className="panel space-y-3 p-4">
        {caps === undefined && !readFailed && (
          <p className="num text-sm text-muted-foreground">Reading the caps…</p>
        )}
        {readFailed && (
          <p className="text-sm text-muted-foreground">
            We could not read the calls in flight just now. Reload to try again.
          </p>
        )}
        {caps && (
          <>
            <p className="text-sm text-muted-foreground">
              Lower a provider's number if your key's tier returns rate-limit errors. A higher
              number can finish a run sooner, and it never changes what the run costs, because
              providers do not bill a rate-limited call.
            </p>
            {caps.map((cap) => {
              const id = `inflight-cap-${cap.provider}`;
              const busy = saving === cap.provider;
              const error = errors[cap.provider];
              return (
                <div key={cap.provider} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="w-48 text-sm" htmlFor={id}>
                      {providerLabel(cap.provider)} calls in flight
                    </label>
                    <Input
                      id={id}
                      className="num w-20"
                      inputMode="numeric"
                      readOnly={cap.envOverrides}
                      value={
                        cap.envOverrides
                          ? String(cap.effective)
                          : (drafts[cap.provider] ?? String(cap.effective))
                      }
                      onChange={(event) => {
                        const text = event.target.value;
                        setDrafts((current) => ({ ...current, [cap.provider]: text }));
                        setErrors((current) => ({ ...current, [cap.provider]: null }));
                      }}
                    />
                    <Button onClick={() => save(cap)} disabled={busy || cap.envOverrides}>
                      {busy && <Loader2 className="size-4 animate-spin" />}
                      Save
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void commit(cap.provider, null)}
                      disabled={busy || cap.envOverrides || cap.stored === null}
                    >
                      Reset to default
                    </Button>
                  </div>
                  {cap.envOverrides && (
                    <p className="text-xs text-muted-foreground">
                      <code className="num">{cap.envName}</code> is set in your environment, and it
                      wins over this field.
                    </p>
                  )}
                  {error && <p className="text-xs text-warn">{error}</p>}
                </div>
              );
            })}
            <p className="num text-xs text-muted-foreground">
              Defaults:{" "}
              {caps.map((cap) => `${providerLabel(cap.provider)} ${cap.defaultCap}`).join(", ")}.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

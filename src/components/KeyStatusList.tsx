import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { providerLabel } from "@/lib/failure-reasons";
import { keyEnvNamesSafe, PROVIDER_KEY_PAGES } from "@/lib/provider-keys";
import type { KeyStatus, ProviderSlug } from "@/components/types";

/**
 * The provider key panel on the settings screens.
 *
 * There is nothing to type in. Keys are read server-side from the environment
 * and never reach the browser, so the panel shows whether one was found and
 * what the provider said when it was last checked. "Check" runs the setup check
 * on the server: one short call to the provider's representative model with web
 * search forced, and a verdict from lib/setup-check with a status, a sentence
 * for the user and where to fix it.
 *
 * With OVERHEARD_MOCK_PROVIDERS=1 the offline seam answers for every provider,
 * so `configured` is true with no key anywhere. `source` tells the row which of
 * the two it is.
 */
export function KeyStatusList({
  statuses,
  onCheck,
  tourId = "key-status",
  showChecks = true,
}: {
  statuses: KeyStatus[];
  /** Runs the server-side setup check for one provider. */
  onCheck: (provider: ProviderSlug) => void;
  /** Null where the panel is reused away from the tour's target. */
  tourId?: string | null | undefined;
  /**
   * False in the tutorial, where the panel reports the real key status but
   * must not offer to spend anything: the demo needs no keys.
   */
  showChecks?: boolean | undefined;
}) {
  return (
    <div className="panel divide-y divide-border" data-tour={tourId ?? undefined}>
      {statuses.length === 0 && (
        <p className="p-4 text-sm text-muted-foreground">No providers are known to this build.</p>
      )}
      {statuses.map((status) => (
        <div key={status.provider} className="flex flex-wrap items-center gap-3 p-4">
          <span className="min-w-24 text-sm font-medium">{providerLabel(status.provider)}</span>

          {status.configured ? (
            <span className="inline-flex items-center gap-1 text-xs text-primary">
              <Check className="size-3.5" />
              {/* "key found" on a machine with no keys at all, said three times
                  over, is the first thing a reader of the repo sees when they
                  boot the demo with OVERHEARD_MOCK_PROVIDERS=1. */}
              {status.source === "mock" ? "mock provider" : "key found"}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <X className="size-3.5" />
              No key. Add{" "}
              <code className="num text-foreground">
                {keyEnvNamesSafe(status.provider) ?? "its API key"}
              </code>{" "}
              to your .env file, then restart.
            </span>
          )}

          {status.problem && <p className="basis-full text-xs text-warn">{status.problem}</p>}

          <div className="ml-auto flex items-center gap-3">
            {status.result.state === "done" && (
              <span
                className={`max-w-md text-xs ${
                  status.result.status === "ok" || status.result.status === "mocked"
                    ? "text-primary"
                    : "text-warn"
                }`}
              >
                {status.result.message}
                {status.result.hint && (
                  <span className="block text-muted-foreground">{status.result.hint}</span>
                )}
              </span>
            )}
            {showChecks && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!status.configured || status.result.state === "checking"}
                onClick={() => onCheck(status.provider)}
              >
                {status.result.state === "checking" && (
                  <Loader2 className="mr-2 size-3.5 animate-spin" />
                )}
                Check
              </Button>
            )}
          </div>
        </div>
      ))}
      <p className="p-4 text-xs text-muted-foreground">
        Overheard AI reads keys from the environment when it starts. It never sends them to the
        browser, writes them to the database or logs them. Change one in your .env and restart to
        pick it up. The provider bills your runs to you directly.
      </p>
      <details className="px-4 pb-4">
        <summary className="cursor-pointer py-1 text-xs text-muted-foreground">
          Where do I get a key?
        </summary>
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {PROVIDER_KEY_PAGES.map(({ provider, url }) => (
            <li key={provider}>
              {providerLabel(provider)}:{" "}
              <a href={url} target="_blank" rel="noreferrer" className="text-primary underline">
                {url.replace(/^https:\/\//, "")}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

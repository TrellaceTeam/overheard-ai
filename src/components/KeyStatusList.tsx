import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AvailabilityView } from "@/lib/assistant-menu";
import { providerLabel } from "@/lib/failure-reasons";
import {
  isCliProvider,
  keyEnvNamesSafe,
  PROVIDER_CLI,
  PROVIDER_KEY_PAGES,
} from "@/lib/provider-keys";
import type { KeyStatus, ProviderSlug } from "@/components/types";

/** What stands behind a configured row. */
function sourceLabel(status: KeyStatus): string {
  if (status.source === "mock") return "mock provider";
  if (status.source === "cli" && isCliProvider(status.provider)) {
    const cli = PROVIDER_CLI[status.provider];
    return `via ${cli.command}, on your ${cli.plan} plan`;
  }
  return "key found";
}

/**
 * The provider key panel on the settings screens.
 *
 * There is nothing to type in. Keys are read server-side from the environment
 * and never reach the browser, so the panel shows whether one was found and
 * what the provider said when it was last checked. "Check" runs the setup check
 * on the server: one short call to the provider's representative model with web
 * search forced, and a verdict from lib/setup-check with a status, a sentence
 * for the user and where to fix it. While a provider has no key, one "Check
 * again" under the rows reads the key status again: the server re-reads .env
 * on every read, so that costs nothing and needs no restart.
 *
 * With OVERHEARD_MOCK_PROVIDERS=1 the offline seam answers for every provider,
 * so `configured` is true with no key anywhere. In subscription mode a
 * provider's command line tool answers on the user's plan, also with no key.
 * `source` tells the row which it is.
 */
export function KeyStatusList({
  statuses,
  onCheck,
  tourId = "key-status",
  showChecks = true,
  onRecheckKeys,
  availability,
  modelNames,
}: {
  statuses: KeyStatus[];
  /** Runs the server-side setup check for one provider. */
  onCheck: (provider: ProviderSlug) => void;
  /** Reads the key status again while a provider has no key. Free, so shown even in the tutorial. */
  onRecheckKeys?: (() => void) | undefined;
  /** Which catalogue models each key can use, from the providers' own lists. */
  availability?: Readonly<Record<string, AvailabilityView | undefined>> | undefined;
  /** Display names of the current catalogue models, by provider model id. */
  modelNames?: ReadonlyMap<string, string> | undefined;
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
              {sourceLabel(status)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <X className="size-3.5" />
              No key. Add{" "}
              <code className="num text-foreground">
                {keyEnvNamesSafe(status.provider) ?? "its API key"}
              </code>{" "}
              to your .env file.
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
            {showChecks && status.configured && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={status.result.state === "checking"}
                onClick={() => onCheck(status.provider)}
              >
                {status.result.state === "checking" && (
                  <Loader2 className="mr-2 size-3.5 animate-spin" />
                )}
                Check
              </Button>
            )}
          </div>

          {status.configured && (
            <ModelsOnKey report={availability?.[status.provider]} names={modelNames} />
          )}
        </div>
      ))}
      {onRecheckKeys && statuses.some((status) => !status.configured) && (
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-xs text-muted-foreground">
            Added a key to .env? Check again to pick it up. There is no need to restart.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={onRecheckKeys}>
            Check again
          </Button>
        </div>
      )}
      <div className="space-y-1 px-4 py-3">
        <details>
          <summary className="cursor-pointer py-1 text-xs text-muted-foreground">
            How Overheard AI reads keys
          </summary>
          <ul className="my-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
            <li>From the .env file in its folder, read again on every lookup, so no restart.</li>
            <li>A key set in your shell wins over the file.</li>
            <li>Keys never reach the browser, the database or a log.</li>
            <li>The provider bills your runs to you directly.</li>
          </ul>
        </details>
        <details>
          <summary className="cursor-pointer py-1 text-xs text-muted-foreground">
            Where do I get a key?
          </summary>
          <ul className="my-2 space-y-1 text-xs text-muted-foreground">
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
        <details>
          <summary className="cursor-pointer py-1 text-xs text-muted-foreground">
            Use a Claude or ChatGPT plan instead
          </summary>
          <ul className="my-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
            <li>
              With no key, Overheard AI asks through {PROVIDER_CLI.anthropic.tool} or{" "}
              {PROVIDER_CLI.openai.tool} when it is installed and signed in with your plan.
            </li>
            <li>A key, when one is set, wins over the plan.</li>
            <li>The README's subscription mode section says what changes.</li>
          </ul>
        </details>
      </div>
    </div>
  );
}

/**
 * The current catalogue models a key can and cannot use, as the provider's
 * own list reports them. Superseded models are left out of the line: they are
 * kept for past runs, and naming them here would only lengthen it.
 */
function ModelsOnKey({
  report,
  names,
}: {
  report: AvailabilityView | undefined;
  names: ReadonlyMap<string, string> | undefined;
}) {
  if (!report || !names) return null;
  if (report.status === "error") {
    return <p className="basis-full text-xs text-muted-foreground">{report.message}</p>;
  }
  if (report.status !== "ok") return null;
  const named = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const name = names.get(id);
      return name ? [name] : [];
    });
  const available = named(report.available);
  const missing = named(report.missing);
  return (
    <p className="basis-full text-xs text-muted-foreground">
      {available.length > 0
        ? `Models on this key: ${available.join(", ")}.`
        : "This key lists none of the models Overheard AI offers."}
      {missing.length > 0 && ` Not on this key: ${missing.join(", ")}.`}
    </p>
  );
}

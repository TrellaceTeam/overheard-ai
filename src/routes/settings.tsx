import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Database, HardDriveDownload, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DemoProjectSection } from "@/components/DemoProjectSection";
import { InflightCapsSection } from "@/components/InflightCapsSection";
import { KeyStatusList } from "@/components/KeyStatusList";
import type { ProviderSlug } from "@/components/types";
import { useModelAvailability } from "@/components/useModelAvailability";
import { useProviderChecks } from "@/components/useProviderChecks";
import { MockProvidersNotice } from "@/components/MockProvidersNotice";
import { CALL_LIMIT_MAX, CALL_LIMIT_MIN } from "@/lib/call-limits";
import { errorText } from "@/lib/error-text";
import { providerLabel } from "@/lib/failure-reasons";
import { demoState as fetchDemoState, restoreDemoProject } from "@/server/api/demo";
import { listExtractionModels, listModels } from "@/server/api/models";
import { setTutorial } from "@/server/api/tutorial";
import {
  callLimit as fetchCallLimit,
  inflightCaps as fetchInflightCaps,
  keyStatus as fetchKeyStatus,
  databaseInfo,
  setCallLimit as saveCallLimit,
  setInflightCap as saveInflightCap,
  workerStatus,
} from "@/server/api/settings";

/**
 * Owns the application settings screen: what a local-first tool owes its user
 * about itself, plus the run size limit, each provider's calls in flight and
 * the demo project.
 *
 * Which provider keys the environment holds, and whether they work. Where the
 * database file is and how big it has grown, so it can be copied. And whether
 * the background loops are running, because if this process is not running,
 * nothing runs.
 *
 * There is no key entry form. Keys are read from the environment server side,
 * so there is nothing to type in and nothing to store.
 */
export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Account settings - Overheard AI" },
      {
        name: "description",
        content:
          "Provider keys, the run size limit, calls in flight, your database and its backups, the worker, and the demo project.",
      },
    ],
  }),
  component: Settings,
});

/** The status panel re-reads itself while you watch it, but not aggressively. */
const STATUS_POLL_MS = 10000;

function Settings() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const keys = useQuery({ queryKey: ["key-status"], queryFn: () => fetchKeyStatus() });
  const database = useQuery({ queryKey: ["database-info"], queryFn: () => databaseInfo() });
  const worker = useQuery({
    queryKey: ["worker-status"],
    queryFn: () => workerStatus(),
    refetchInterval: STATUS_POLL_MS,
  });
  const demo = useQuery({ queryKey: ["demo-state"], queryFn: () => fetchDemoState() });
  const limits = useQuery({ queryKey: ["call-limit"], queryFn: () => fetchCallLimit() });
  const inflight = useQuery({ queryKey: ["inflight-caps"], queryFn: () => fetchInflightCaps() });
  const [restoring, setRestoring] = useState(false);
  const [limitDraft, setLimitDraft] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [savingLimit, setSavingLimit] = useState(false);

  /**
   * The tutorial reuses the demo if it exists and recreates it at the final
   * step if it was deleted, so all this button does is reopen the front door:
   * mark the tutorial as in setup and hand over to /start.
   */
  async function runTutorial() {
    try {
      await setTutorial({ data: { state: "in_setup" } });
      // Write the cache through rather than invalidating it: an invalidate
      // leaves /start reading a stale "done" for its first render, and the
      // screen would flash normal mode before flipping into the tutorial.
      queryClient.setQueryData(["tutorial-state"], "in_setup");
      void navigate({ to: "/start" });
    } catch (error) {
      toast.error(errorText(error, "Could not start the tutorial"));
    }
  }

  /**
   * Restore, then go look at it: the button exists to put the demo back in
   * front of somebody who deleted it and changed their mind.
   */
  async function restore() {
    setRestoring(true);
    try {
      const { projectId } = await restoreDemoProject();
      void queryClient.invalidateQueries({ queryKey: ["demo-state"] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["most-recent-project"] });
      void navigate({ to: "/projects/$projectId", params: { projectId } });
    } catch (error) {
      toast.error(errorText(error, "Could not restore the demo project"));
      setRestoring(false);
    }
  }

  /**
   * One commit path for Save and Reset, so both invalidate, clear the draft
   * and toast the same way. The draft survives only a failed save, so what was
   * typed is not lost.
   */
  async function commitCallLimit(limit: number) {
    setSavingLimit(true);
    try {
      await saveCallLimit({ data: { limit } });
      void queryClient.invalidateQueries({ queryKey: ["call-limit"] });
      setLimitDraft(null);
      setLimitError(null);
      toast.success("Run size limit saved");
    } catch (error) {
      toast.error(errorText(error, "Could not save the run size limit"));
    } finally {
      setSavingLimit(false);
    }
  }

  /** The calls in flight's commit path, toasting like the run size limit's. */
  async function commitInflightCap(provider: ProviderSlug, cap: number | null) {
    const label = providerLabel(provider);
    try {
      await saveInflightCap({ data: { provider, cap } });
      void queryClient.invalidateQueries({ queryKey: ["inflight-caps"] });
      toast.success(`${label} calls in flight saved`);
      return true;
    } catch (error) {
      toast.error(errorText(error, `Could not save ${label} calls in flight`));
      return false;
    }
  }

  function saveLimit() {
    const text = limitDraft ?? String(limits.data?.limit ?? "");
    const parsed = parseCallLimit(text);
    if (parsed === null) {
      setLimitError(
        `Enter a whole number between ${CALL_LIMIT_MIN.toLocaleString("en-US")} and ${CALL_LIMIT_MAX.toLocaleString("en-US")}.`,
      );
      return;
    }
    void commitCallLimit(parsed);
  }

  // Which catalogue models each key can use, named from the current catalogue.
  const keyedProviders = (keys.data ?? [])
    .filter((row) => row.configured)
    .map((row) => String(row.provider));
  const { availability: modelLists, refresh: refreshModelLists } =
    useModelAvailability(keyedProviders);
  const assistants = useQuery({ queryKey: ["models"], queryFn: () => listModels() });
  const extractors = useQuery({
    queryKey: ["extraction-models"],
    queryFn: () => listExtractionModels(),
  });
  const currentModelNames = new Map(
    [...(assistants.data ?? []), ...(extractors.data ?? [])]
      .filter((model) => model.superseded !== 1)
      .map((model) => [model.model_id, model.display_name] as const),
  );

  // The check state lives in the hook. This route keeps the key query because
  // the Provider keys section also renders its read error. A check reads .env
  // and the model lists again.
  const { statuses, check } = useProviderChecks(keys.data, () => {
    void keys.refetch();
    void refreshModelLists();
  });

  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-10">
      <div>
        <h1 className="text-2xl font-semibold">Account settings</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Everything on this page is about this machine. Nothing here is shared, synced or sent
          anywhere.
        </p>
      </div>

      {worker.data?.mockProviders === true && <MockProvidersNotice />}

      <section className="space-y-3">
        <h2 className="type-section">Provider keys</h2>
        {keys.isError ? (
          <p className="text-sm text-muted-foreground">
            We could not read the key status just now. Reload to try again.
          </p>
        ) : (
          <KeyStatusList
            statuses={statuses}
            onCheck={(provider) => void check(provider)}
            onRecheckKeys={() => void keys.refetch()}
            availability={modelLists}
            modelNames={currentModelNames}
          />
        )}
        <p className="text-xs text-muted-foreground">
          The setup check costs about a cent per OpenAI or Anthropic model and nothing noticeable on
          Gemini. It makes one short call with web search forced, because that is the only way to
          tell a key that signs in from one that can run a search.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="type-section">Your database</h2>
        <div className="panel space-y-3 p-4">
          {database.isPending && (
            <p className="num text-sm text-muted-foreground">Reading the database file…</p>
          )}
          {database.isError && (
            <p className="text-sm text-muted-foreground">
              We could not read the database file just now. Reload to try again.
            </p>
          )}
          {database.data && (
            <>
              <div className="flex items-start gap-3">
                <Database className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0 space-y-1">
                  <p className="num break-all text-sm">{database.data.path}</p>
                  <p className="num text-xs text-muted-foreground">
                    {formatSize(database.data.sizeBytes)} · opened with {database.data.driverModule}
                    {database.data.exists ? "" : " · not written yet"}
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                The size counts the write-ahead log as well as the main file, because both are part
                of the database.
              </p>
            </>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="type-section">Backing up</h2>
        <div className="panel space-y-2 p-4 text-sm text-muted-foreground">
          <p className="flex items-center gap-2 font-medium text-foreground">
            <HardDriveDownload className="size-4 text-primary" />
            Copy three files, with Overheard AI closed
          </p>
          <p>
            Stop Overheard AI, then copy the database file above together with the two files beside
            it whose names end in <code className="num">-wal</code> and{" "}
            <code className="num">-shm</code>. A copy of the main file alone can be missing your
            most recent run.
          </p>
          <p>
            To restore, put all three back and start Overheard AI again. To start over, delete them.
            There is no other copy of your data, here or anywhere else.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="type-section">Worker</h2>
        <div className="panel space-y-3 p-4 text-sm">
          {worker.isPending && (
            <p className="num flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Checking…
            </p>
          )}
          {worker.isError && (
            <p className="text-muted-foreground">We could not reach the worker status just now.</p>
          )}
          {worker.data && (
            <>
              <p>
                Run queue:{" "}
                <span className={worker.data.running ? "text-primary" : "text-warn"}>
                  {worker.data.running ? "running" : "stopped"}
                </span>
                {worker.data.lastPass && (
                  <span className="num text-muted-foreground">
                    {" "}
                    · last pass handled {worker.data.lastPass.processed} answer
                    {worker.data.lastPass.processed === 1 ? "" : "s"} and finished{" "}
                    {worker.data.lastPass.finalised} run
                    {worker.data.lastPass.finalised === 1 ? "" : "s"}
                  </span>
                )}
              </p>
              <p>
                Schedules:{" "}
                <span className={worker.data.scheduler.running ? "text-primary" : "text-warn"}>
                  {worker.data.scheduler.running ? "sweeping" : "stopped"}
                </span>
                {worker.data.scheduler.lastSummary && (
                  <span className="num text-muted-foreground">
                    {" "}
                    · last sweep started {worker.data.scheduler.lastSummary.created} run
                    {worker.data.scheduler.lastSummary.created === 1 ? "" : "s"} and skipped{" "}
                    {worker.data.scheduler.lastSummary.skipped}
                  </span>
                )}
              </p>
              {worker.data.scheduler.lastError && (
                <p className="num text-xs text-warn">
                  Last sweep error: {worker.data.scheduler.lastError}
                </p>
              )}
            </>
          )}
          <p className="text-xs text-muted-foreground">
            Both loops live inside this process, so they only run while Overheard AI is running. Run
            one Overheard AI process per database file. A second copy on the same file would claim
            the same work twice.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="type-section">Run size limit</h2>
        <div className="panel space-y-3 p-4">
          {limits.isPending && (
            <p className="num text-sm text-muted-foreground">Reading the limit…</p>
          )}
          {limits.isError && (
            <p className="text-sm text-muted-foreground">
              We could not read the run size limit just now. Reload to try again.
            </p>
          )}
          {limits.data && (
            <>
              <p className="text-sm text-muted-foreground">
                A run bigger than this many provider calls is refused before anything is spent. Most
                installs never change it.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-sm" htmlFor="call-limit">
                  Max planned calls per run
                </label>
                <Input
                  id="call-limit"
                  className="num w-40"
                  inputMode="numeric"
                  value={limitDraft ?? String(limits.data.limit)}
                  onChange={(event) => {
                    setLimitDraft(event.target.value);
                    setLimitError(null);
                  }}
                />
                <Button onClick={saveLimit} disabled={savingLimit}>
                  {savingLimit && <Loader2 className="size-4 animate-spin" />}
                  Save
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void commitCallLimit(limits.data.defaultLimit)}
                  disabled={savingLimit || limits.data.limit === limits.data.defaultLimit}
                >
                  Reset to default
                </Button>
              </div>
              {limitError && <p className="text-xs text-warn">{limitError}</p>}
              <p className="num text-xs text-muted-foreground">
                Default: {limits.data.defaultLimit.toLocaleString("en-US")} calls.
              </p>
            </>
          )}
        </div>
      </section>

      <InflightCapsSection
        caps={inflight.data}
        readFailed={inflight.isError}
        onCommit={commitInflightCap}
      />

      <DemoProjectSection
        // An unreadable demo state maps to "missing" rather than "unknown":
        // restore is idempotent, so the button doubles as the retry, and with
        // a demo present it simply navigates to it.
        exists={demo.isPending ? null : demo.isError ? false : demo.data.exists}
        busy={restoring}
        onRestore={() => void restore()}
        onRunTutorial={() => void runTutorial()}
      />
    </main>
  );
}

/**
 * The call-limit field's parser: a whole number inside lib/call-limits' bounds,
 * or null so the field can say what is wrong instead of sending a save that
 * will be refused. Spaces, commas and underscores are forgiven because people
 * type 500 000 and 500,000 into number fields.
 *
 * The server reads the same bounds, so the parser, its sentence and the
 * planner cannot drift. Migration 0005's SQL CHECK is a separate copy because
 * it cannot import TypeScript.
 */
export function parseCallLimit(text: string): number | null {
  const cleaned = text.trim().replace(/[\s,_]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return value >= CALL_LIMIT_MIN && value <= CALL_LIMIT_MAX ? value : null;
}

/** Bytes as something a person can compare to the free space on a disk. */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return "in memory";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0] ?? "KB";
  for (const next of units.slice(1)) {
    if (value < 1024) break;
    value = value / 1024;
    unit = next;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

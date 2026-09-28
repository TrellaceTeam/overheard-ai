import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DemoReadOnlyNote } from "@/components/DemoReadOnlyNote";
import { BadgeInput } from "@/components/BadgeInput";
import { ScheduleCard, detectTimezone } from "@/components/ScheduleCard";
import { useIsDemo } from "@/components/useIsDemo";
import type { Schedule, ScheduleDraft } from "@/components/types";
import { keyEnvNamesSafe } from "@/lib/provider-keys";
import { errorText } from "@/lib/error-text";
import { BRAND_TOKEN, perceptionEnabled, resolvePerceptionPrompt } from "@/lib/perception";
import { isPlausibleDomain, normalizeDomain } from "@/lib/brand-matching";
import { afterDeleteDestination } from "@/lib/launch";
import { getTargetBrand, recomputeCitations, updateBrand } from "@/server/api/brands";
import { listExtractionModels } from "@/server/api/models";
import { getPerceptionState } from "@/server/api/perception";
import {
  deleteProject,
  getProjectSettings,
  mostRecentProject,
  updateProject,
} from "@/server/api/projects";
import { createPerceptionRun, kickWorker } from "@/server/api/runs";
import { disableSchedule, getSchedule, nextOccurrence, saveSchedule } from "@/server/api/schedules";
import { keyStatus as fetchKeyStatus } from "@/server/api/settings";

/**
 * Owns everything configurable about one project: the brand it watches, the
 * perception prompt, the schedule, which model reads the answers back, and
 * deleting the lot.
 *
 * Two things live elsewhere. Provider keys come from the environment, so they
 * belong to the machine and sit in Account settings. Which assistants a run
 * asks is part of running it, so the selection sits in the Runner on the
 * Prompts tab. What this page shows of the keys is their consequence: an
 * extractor whose provider has no key is locked, with a sentence saying so.
 *
 * Domains are a draft, written on Save behind a confirm, because changing one
 * re-scores every answer already collected. An extractor whose key status has
 * not been read yet is held with "checking", never explained away as a missing
 * key: a query in flight is not a denial.
 */
export const Route = createFileRoute("/projects/$projectId/settings")({
  head: () => ({
    meta: [
      { title: "Project settings - Overheard AI" },
      { name: "description", content: "Brand, perception prompt, schedule and extraction." },
    ],
  }),
  component: ProjectSettings,
});

/**
 * Whether two ordered lists hold the same entries, compared entry by entry: a
 * comma join would call ["a,b"] and ["a", "b"] the same list.
 */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function ProjectSettings() {
  const { projectId } = useParams({ from: "/projects/$projectId/settings" });
  const isDemo = useIsDemo(projectId);

  return (
    <div className="space-y-8">
      {isDemo && (
        <DemoReadOnlyNote note="The demo project is browse-only. You can still delete it, and Account settings can restore it." />
      )}
      {/* One disabled fieldset locks every section but the last, because the
          inputs, switches and selects are native buttons and inputs
          underneath. Deleting the demo stays allowed, and Account settings
          can restore it, so the danger section sits outside the lock. */}
      <fieldset disabled={isDemo} className="m-0 min-w-0 space-y-8 border-0 p-0">
        <YourBrandSection projectId={projectId} />
        <PerceptionSection projectId={projectId} />
        <ScheduleSection projectId={projectId} isDemo={isDemo} />
        <ExtractionSection projectId={projectId} />
      </fieldset>
      <DangerSection projectId={projectId} />
    </div>
  );
}

function SectionHeading({ children }: { children: string }) {
  return <h2 className="type-section">{children}</h2>;
}

/* ------------------------------------------------------------------ brand */

function YourBrandSection({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  // Null means untouched, tracking whatever the server holds. Seeding state
  // from an async query would need an effect, and the effect would clobber an
  // edit in progress on every refetch. The variance draft is a chip list, the
  // same control the name variants use: a pasted comma-separated list splits
  // into chips on commit, inside badge-input.logic.
  const [primaryDraft, setPrimaryDraft] = useState<string | null>(null);
  const [varianceDraft, setVarianceDraft] = useState<string[] | null>(null);
  const [confirmDomains, setConfirmDomains] = useState(false);
  const [saving, setSaving] = useState(false);

  const brand = useQuery({
    queryKey: ["target-brand", projectId],
    queryFn: () => getTargetBrand({ data: { projectId } }),
  });

  const row = brand.data ?? null;
  const savedPrimary = row?.domains[0] ?? "";
  const savedVariance = (row?.domains ?? []).slice(1);
  const primary = primaryDraft ?? savedPrimary;
  const variance = varianceDraft ?? savedVariance;
  const domainsDirty = primary !== savedPrimary || !sameList(variance, savedVariance);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["target-brand", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["brands", projectId] });
  }

  async function patch(data: { variants?: string[]; suggestedDomains?: string[] }) {
    if (!row) return;
    try {
      await updateBrand({ data: { id: row.id, ...data } });
      invalidate();
    } catch (error) {
      toast.error(errorText(error, "That did not save"));
    }
  }

  /**
   * Every change to this brand's domains goes through here.
   *
   * Values are validated before they are stored, so a pasted sentence cannot
   * become six domains. Then citations are recomputed: is_cited is decided when
   * an answer is extracted, so without it a corrected typo changes no number.
   * Recomputing costs nothing and asks no assistant anything, because the
   * links are already stored.
   */
  async function saveDomains(next: string[], alsoSuggested?: string[]) {
    if (!row) return;
    const entered = next.map((domain) => domain.trim()).filter(Boolean);
    const bad = entered.filter((domain) => !isPlausibleDomain(domain));
    if (bad.length > 0) {
      toast.error(
        `${bad.join(", ")} ${bad.length === 1 ? "does" : "do"} not look like a domain. Use the form acme.example.com.`,
      );
      return;
    }
    const cleaned = [...new Set(entered.map(normalizeDomain))];
    if (cleaned.length === 0) {
      toast.error(
        "Keep at least one domain. A citation is an answer that links one of them, so with none your citation rate can only ever be 0%",
      );
      return;
    }

    const unchanged = sameList(cleaned, row.domains);
    if (unchanged && alsoSuggested === undefined) return;

    setSaving(true);
    try {
      await updateBrand({
        data: {
          id: row.id,
          domains: cleaned,
          ...(alsoSuggested === undefined ? {} : { suggestedDomains: alsoSuggested }),
        },
      });
      setPrimaryDraft(null);
      setVarianceDraft(null);
      invalidate();
      if (unchanged) return;

      const result = await recomputeCitations({ data: { brandId: row.id } });
      toast.success(
        result.changed === 0
          ? "Domains saved. No past citation changed"
          : `Domains saved. ${result.changed} citation${result.changed === 1 ? "" : "s"} corrected across ${result.runs} run${result.runs === 1 ? "" : "s"}`,
      );
      void queryClient.invalidateQueries({ queryKey: ["project-metrics", projectId] });
    } catch (error) {
      toast.error(errorText(error, "Domains saved, but we could not update your past runs"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3">
      <SectionHeading>Your brand</SectionHeading>
      {!row ? (
        <p className="text-sm text-muted-foreground">
          {brand.isPending
            ? "Loading your brand…"
            : brand.isError
              ? "We could not load your brand just now. Reload to try again."
              : "No brand is configured for this project yet."}
        </p>
      ) : (
        <div className="panel space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Brand name</Label>
              <Input aria-label="Brand name" value={row.name} readOnly disabled />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Domain</Label>
              <Input
                aria-label="Domain"
                value={primary}
                placeholder="acme.example.com"
                onChange={(e) => setPrimaryDraft(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="brand-variants">
                Name variants
              </Label>
              {/* Chips, like the wizard and the Competitors page, so the same
                  data behaves the same in all three places and an entry is
                  visibly committed. */}
              <BadgeInput
                id="brand-variants"
                value={row.variants}
                onChange={(variants) => void patch({ variants })}
                placeholder="Add a name variant"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Other domains</Label>
              {/* Chips, like the name variants above: both lists are the same
                  data edited the same way, and a pasted comma-separated list
                  splits into chips on commit. The draft still saves behind the
                  confirm, because a domain change re-scores every past run. */}
              <BadgeInput
                id="domain-variants"
                value={variance}
                onChange={setVarianceDraft}
                placeholder="Add a domain variant"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!domainsDirty || saving}
              onClick={() => setConfirmDomains(true)}
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save domains
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!domainsDirty || saving}
              onClick={() => {
                setPrimaryDraft(null);
                setVarianceDraft(null);
              }}
            >
              Discard
            </Button>
            {domainsDirty && (
              <p className="text-xs text-muted-foreground">
                Saving re-scores every past run against these domains.
              </p>
            )}
          </div>

          {row.suggestedDomains.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/30 p-2">
              <span className="text-xs text-muted-foreground">
                Seen citing you in a run. Add it as another domain?
              </span>
              {row.suggestedDomains.map((domain) => (
                <Button
                  key={domain}
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void saveDomains(
                      [...row.domains, domain],
                      row.suggestedDomains.filter((other) => other !== domain),
                    )
                  }
                >
                  + {domain}
                </Button>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void patch({ suggestedDomains: [] })}
              >
                Dismiss
              </Button>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            The brand name is fixed for this project, but domains are not. Correcting one re-scores
            every past run against it at no cost, because the links are already stored.
          </p>
        </div>
      )}

      <AlertDialog open={confirmDomains} onOpenChange={(open) => !open && setConfirmDomains(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save these domains?</AlertDialogTitle>
            <AlertDialogDescription>
              Saving re-scores every answer already collected against them, so your citation rate
              can move up or down on finished runs. It costs nothing and asks no assistant anything,
              because the links are already stored. Your prompts do not run again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDomains(false);
                void saveDomains([primary, ...variance]);
              }}
            >
              Save and re-score
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/* ------------------------------------------------------------- perception */

function PerceptionSection({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [asking, setAsking] = useState(false);

  const state = useQuery({
    queryKey: ["perception", projectId],
    queryFn: () => getPerceptionState({ data: { projectId } }),
  });
  const brand = useQuery({
    queryKey: ["target-brand", projectId],
    queryFn: () => getTargetBrand({ data: { projectId } }),
  });

  const saved = state.data?.prompt ?? "";
  const text = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  // Resolved the way createPerceptionRun resolves it at fan-out, so the preview
  // is the question that gets asked.
  const preview = resolvePerceptionPrompt(text, brand.data?.name ?? null);
  const stale = state.data?.stale === true;

  async function askAgain(message: (answers: number) => string) {
    setAsking(true);
    try {
      const result = await createPerceptionRun({ data: { projectId } });
      toast.success(message(result.answers));
      void kickWorker().catch(() => undefined);
      void queryClient.invalidateQueries({ queryKey: ["perception", projectId] });
    } catch (error) {
      toast.error(errorText(error, "Saved, but we could not ask the prompt just now"));
    } finally {
      setAsking(false);
    }
  }

  async function save() {
    try {
      await updateProject({ data: { projectId, perceptionPrompt: text } });
    } catch (error) {
      toast.error(errorText(error, "That did not save"));
      return;
    }
    setDraft(null);
    void queryClient.invalidateQueries({ queryKey: ["perception", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["project-settings", projectId] });

    if (!perceptionEnabled(text)) {
      toast.success("Perception prompt cleared. It will not be asked again");
      return;
    }
    // A saved edit makes every existing answer a reply to a question nobody is
    // asking, so the new one goes out straight away rather than being offered.
    await askAgain((n) => `Saved. Asking ${n} assistant${n === 1 ? "" : "s"} the new prompt`);
  }

  return (
    <section className="space-y-3">
      <SectionHeading>Perception prompt</SectionHeading>
      <div className="panel space-y-4 p-4">
        <p className="text-sm text-muted-foreground">
          One prompt that asks each assistant what it thinks your brand is. It runs once when you
          set up the project, and again only when you change it here or press Ask again on the
          dashboard, because a description does not change from one day to the next. It measures
          nothing, and its answers never reach your mention rate, top 3 rate or citation rate.{" "}
          <code className="num">{BRAND_TOKEN}</code> becomes your brand name when it runs.
        </p>

        <Textarea
          rows={8}
          aria-label="Perception prompt"
          value={text}
          onChange={(e) => setDraft(e.target.value)}
        />

        <div className="space-y-1">
          <p className="type-label">Asked as</p>
          <p className="num rounded-md border border-border bg-secondary p-3 text-xs">
            {perceptionEnabled(text) ? preview : "Nothing. A blank prompt switches perception off."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!dirty || asking} onClick={() => setConfirm(true)}>
            {asking && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
          <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setDraft(null)}>
            Discard
          </Button>
          {dirty && (
            <p className="text-xs text-muted-foreground">
              Saving asks each assistant the new prompt once, on your own keys.
            </p>
          )}
        </div>

        {stale && !dirty && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-secondary p-3">
            <p className="text-xs text-muted-foreground">
              Your dashboard is showing answers to an earlier version of this prompt.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={asking}
              onClick={() => void askAgain((n) => `Asking again. ${n} answer${n === 1 ? "" : "s"}`)}
            >
              {asking && <Loader2 className="size-4 animate-spin" />}
              Ask again
            </Button>
          </div>
        )}
      </div>

      <AlertDialog open={confirm} onOpenChange={(open) => !open && setConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save and ask again?</AlertDialogTitle>
            <AlertDialogDescription>
              {perceptionEnabled(text)
                ? "Saving asks each assistant the new perception prompt once, on your own provider keys. Your prompts do not run again, and none of your measured numbers change. Until the new answers land, the ones on your dashboard reply to the old wording."
                : "Clearing this switches perception off. Nothing will be asked, and the answers already on your dashboard stay where they are."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirm(false);
                void save();
              }}
            >
              Save and ask
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/* --------------------------------------------------------------- schedule */

function ScheduleSection({ projectId, isDemo }: { projectId: string; isDemo: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const stored = useQuery({
    queryKey: ["schedule", projectId],
    queryFn: () => getSchedule({ data: { projectId } }),
  });

  const row = stored.data ?? null;
  const schedule: Schedule | null = row
    ? {
        id: row.id,
        cadence: row.cadence,
        day_of_week: row.dayOfWeek,
        day_of_month: row.dayOfMonth,
        hour_utc: row.hourUtc,
        timezone: row.timezone,
        is_active: row.isActive,
        next_run_at: row.nextRunAt,
        last_run_at: row.lastRunAt,
        last_skip_reason: row.lastSkipReason,
      }
    : null;

  // The preview is the scheduler's own nextOccurrence, run server side over a
  // draft nobody has committed to, so the card and the stored next_run_at can
  // never disagree about a daylight-saving boundary.
  const effective: ScheduleDraft = draft ?? {
    cadence: row?.cadence ?? "weekly",
    dayOfWeek: row?.cadence === "weekly" ? (row.dayOfWeek ?? 1) : null,
    dayOfMonth: row?.cadence === "monthly" ? (row.dayOfMonth ?? 1) : null,
    hourUtc: row?.hourUtc ?? 8,
    timezone: row?.timezone ?? detectTimezone(),
  };

  const preview = useQuery({
    queryKey: ["next-occurrence", effective],
    queryFn: () =>
      nextOccurrence({
        data: {
          cadence: effective.cadence,
          dayOfWeek: effective.dayOfWeek,
          dayOfMonth: effective.dayOfMonth,
          hourUtc: effective.hourUtc,
          timezone: effective.timezone,
        },
      }),
    retry: false,
  });

  async function save(next: ScheduleDraft) {
    setSaving(true);
    try {
      await saveSchedule({
        data: {
          projectId,
          cadence: next.cadence,
          dayOfWeek: next.dayOfWeek,
          dayOfMonth: next.dayOfMonth,
          hourUtc: next.hourUtc,
          timezone: next.timezone,
          isActive: true,
        },
      });
      toast.success("Schedule saved");
      void queryClient.invalidateQueries({ queryKey: ["schedule", projectId] });
    } catch (error) {
      toast.error(errorText(error, "That did not save"));
    } finally {
      setSaving(false);
    }
  }

  async function disable() {
    setSaving(true);
    try {
      await disableSchedule({ data: { projectId } });
      toast.success("Automatic runs paused. Your settings are kept");
      void queryClient.invalidateQueries({ queryKey: ["schedule", projectId] });
    } catch (error) {
      toast.error(errorText(error, "That did not save"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3">
      <SectionHeading>Schedule</SectionHeading>
      <ScheduleCard
        schedule={schedule}
        nextOccurrence={preview.data ? formatWhen(preview.data.nextRunAt) : null}
        onSave={(next) => void save(next)}
        onDisable={() => void disable()}
        onDraftChange={setDraft}
        saving={saving}
        isDemo={isDemo}
      />
    </section>
  );
}

/** An ISO instant as the local time somebody will actually be at the machine. */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/* -------------------------------------------------------------- extraction */

function ExtractionSection({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();

  const extractors = useQuery({
    queryKey: ["extraction-models"],
    queryFn: () => listExtractionModels(),
  });
  const keys = useQuery({ queryKey: ["key-status"], queryFn: () => fetchKeyStatus() });
  const settings = useQuery({
    queryKey: ["project-settings", projectId],
    queryFn: () => getProjectSettings({ data: { projectId } }),
  });

  const keyedProviders = new Set(
    (keys.data ?? []).filter((row) => row.configured).map((row) => String(row.provider)),
  );
  // Until the key check answers we do not know what is reachable, so a model is
  // held rather than explained away as "no key for this provider".
  const keysUnresolved = keys.isPending || keys.isError;

  async function setExtractor(modelId: string) {
    try {
      await updateProject({ data: { projectId, extractionModelId: modelId } });
      toast.success("Extractor updated");
      void queryClient.invalidateQueries({ queryKey: ["project-settings", projectId] });
    } catch (error) {
      toast.error(errorText(error, "That did not save"));
    }
  }

  // The extraction prompt's draft, as in the perception section: null shows
  // what is saved. Save commits, and Reset to default only fills the box.
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const savedPrompt = settings.data?.extractionPrompt ?? "";
  const promptText = promptDraft ?? savedPrompt;
  const promptDirty = promptDraft !== null && promptDraft !== savedPrompt;
  const promptDefault = settings.data?.extractionPromptDefault ?? "";

  async function saveExtractionPrompt() {
    try {
      await updateProject({ data: { projectId, extractionPrompt: promptText } });
      toast.success("Saved. Future answers will be read with this prompt");
      setPromptDraft(null);
      void queryClient.invalidateQueries({ queryKey: ["project-settings", projectId] });
    } catch (error) {
      toast.error(errorText(error, "That did not save"));
    }
  }

  return (
    <section className="space-y-3">
      <SectionHeading>Extractor</SectionHeading>
      <p className="text-sm text-muted-foreground">
        A cheap model reads every answer and turns it into structured mentions. Pick one whose
        provider key you have. Current models come first, cheapest first, and older ones after them.
      </p>
      <div className="panel p-4">
        <Select
          value={settings.data?.extractionModelId ?? ""}
          onValueChange={(value) => void setExtractor(value)}
        >
          <SelectTrigger className="w-72" aria-label="Extractor">
            <SelectValue placeholder="Select an extractor" />
          </SelectTrigger>
          <SelectContent>
            {(extractors.data ?? []).map((model) => {
              const held = keysUnresolved;
              const locked =
                !held &&
                !keyedProviders.has(model.provider) &&
                settings.data?.extractionModelId !== model.id;
              return (
                <SelectItem key={model.id} value={model.id} disabled={locked || held}>
                  {model.display_name}
                  {model.superseded === 1 ? " · older" : ""}
                  {held
                    ? " (checking your keys…)"
                    : locked
                      ? ` (set ${keyEnvNamesSafe(model.provider) ?? "the provider key"} to unlock)`
                      : ""}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
      <div className="panel space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          The instructions the extractor follows for every answer. Change them for this project only
          when the default misreads your answers. An edit changes how{" "}
          <span className="font-medium">future</span> answers are read. Scores already stored stand,
          and past answers are not read again.
        </p>
        <Textarea
          rows={12}
          aria-label="Extraction prompt"
          value={promptText}
          onChange={(e) => setPromptDraft(e.target.value)}
          className="font-mono text-xs"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!promptDirty || promptText.trim() === ""}
            onClick={() => void saveExtractionPrompt()}
          >
            Save prompt
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={promptText === promptDefault}
            onClick={() => setPromptDraft(promptDefault)}
          >
            Reset to default
          </Button>
          {promptDirty && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setPromptDraft(null)}>
              Discard
            </Button>
          )}
          {promptText.trim() === "" && (
            <p className="text-sm text-warn">The extractor needs a prompt. Write one or reset.</p>
          )}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- danger */

function DangerSection({ projectId }: { projectId: string }) {
  const isDemo = useIsDemo(projectId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    setDeleting(true);
    try {
      await deleteProject({ data: { projectId } });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["most-recent-project"] });
      toast.success("Project deleted");
      // A confirmed last project goes straight to /start, which the front door
      // would also pick, after flashing "Opening your projects…". Anything
      // else, a project left or a failed read, is the front door's decision,
      // because it also re-reads the tutorial state.
      const next = await mostRecentProject().then(
        (result) => result.projectId,
        () => undefined,
      );
      const destination = afterDeleteDestination(next);
      void navigate(destination.to === "start" ? { to: "/start" } : { to: "/" });
    } catch (error) {
      toast.error(errorText(error, "We could not delete the project"));
      setDeleting(false);
    }
  }

  return (
    <section className="space-y-3">
      <SectionHeading>Delete this project</SectionHeading>
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          Deletes the brand, the prompts, every run and every answer in this project. Your other
          projects and your database file are untouched.
        </p>
        <Button
          variant="outline"
          className="text-destructive"
          disabled={deleting}
          onClick={() => setConfirm(true)}
        >
          {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
          Delete project
        </Button>
      </div>

      <AlertDialog open={confirm} onOpenChange={(open) => !open && setConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              {isDemo
                ? "This removes the demo project and its invented history. You can restore it at any time from Account settings."
                : "Every run, answer and measurement in it goes with it, and there is no other copy. This cannot be undone from inside Overheard AI: only a backup of the database file can bring it back."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirm(false);
                void remove();
              }}
            >
              Delete project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

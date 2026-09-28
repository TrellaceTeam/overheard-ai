import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2, Play, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AvailabilityNotice, NO_KEY_CONFIGURED } from "@/components/AvailabilityNotice";
import { KeyStatusList } from "@/components/KeyStatusList";
import { LockLine } from "@/components/LockLine";
import { MockProvidersNotice } from "@/components/MockProvidersNotice";
import { PerceptionPromptCard } from "@/components/PerceptionPromptCard";
import { RunPlanSummary } from "@/components/RunPlanSummary";
import { TOUR_SELECTORS, useTour } from "@/components/TutorialTour";
import { Button } from "@/components/ui/button";
import { useProviderChecks } from "@/components/useProviderChecks";
import { useSelectionCheck } from "@/components/useSelectionCheck";
import { EMPTY_WIZARD_DRAFT, useWizardForm } from "@/components/useWizardForm";
import { type CatalogModel, WizardAssistantPicker } from "@/components/WizardAssistantPicker";
import { WizardBrandStep } from "@/components/WizardBrandStep";
import { WizardPromptDoors } from "@/components/WizardPromptDoors";
import { WizardPromptList } from "@/components/WizardPromptList";
import { WizardSetupCheckPanel } from "@/components/WizardSetupCheckPanel";
import { resolveFeature } from "@/lib/availability";
import { orderAssistants } from "@/lib/dashboard-filters";
import { errorText } from "@/lib/error-text";
import { isTutorialMode } from "@/lib/launch";
import { createGate, estimateWizardSpend, pickExtractor } from "@/lib/onboarding";
import { modelPrices } from "@/lib/run-estimate";
import { newProjectPlan } from "@/lib/run-plan";
import { toAnswers } from "@/lib/run-progress";
import {
  browserStorage,
  clearSetupDraft,
  draftHasContent,
  readSetupDraft,
  writeSetupDraft,
} from "@/lib/setup-draft";
import {
  estimateGenerationCost,
  generateState,
  generationFailedToast,
  pickGenerationModel,
  starterGenerationChars,
} from "@/lib/starter-generation";
import { demoPrefill as fetchDemoPrefill, restoreDemoProject } from "@/server/api/demo";
import { listExtractionModels, listModels } from "@/server/api/models";
import { createProject } from "@/server/api/projects";
import { createRun } from "@/server/api/runs";
import {
  callLimit as fetchCallLimit,
  keyStatus as fetchKeyStatus,
  workerStatus,
} from "@/server/api/settings";
import { generateStarterPrompts } from "@/server/api/starter-prompts";
import { setTutorial, tutorialState as fetchTutorialState } from "@/server/api/tutorial";

/**
 * Project setup in two steps: the brand, then the questions and the assistants
 * that answer them, ending in the project's first run.
 *
 * While the install's tutorial is not done, the same screen shows the demo
 * project's values, locked, and the tour's popups walk it. Its last button
 * builds the demo instead of creating a project, so nothing is spent.
 */
export const Route = createFileRoute("/start")({
  head: () => ({
    meta: [
      { title: "Start watching a brand - Overheard AI" },
      {
        name: "description",
        content: "Add your brand and the prompts your buyers ask, then see your first results.",
      },
    ],
  }),
  component: Start,
});

type DefaultCandidate = { id: string; provider: string; tier: string; superseded?: number };

/**
 * One assistant per provider with a key: the current mid-tier model. An
 * extraction-tier model is cheap at reading an answer back, not at writing the
 * answer a first impression rests on, and a superseded one is kept only for
 * the projects already asking it.
 */
export function defaultAssistantIds(
  models: ReadonlyArray<DefaultCandidate>,
  keyedProviders: readonly string[],
): string[] {
  return oneMidPerProvider(models.filter((model) => keyedProviders.includes(model.provider)));
}

/**
 * The tutorial's selection: one current mid-tier model per provider, whatever
 * keys exist. The demo never calls them, and greying out providers with no key
 * would teach the wrong lesson about what the grid does.
 */
export function oneMidPerProvider(models: ReadonlyArray<DefaultCandidate>): string[] {
  const perProvider = new Map<string, string>();
  for (const model of models) {
    if (model.tier !== "mid" || model.superseded === 1) continue;
    if (!perProvider.has(model.provider)) perProvider.set(model.provider, model.id);
  }
  return [...perProvider.values()];
}

function Start() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // While the tour's setup half is up, the screen follows the tour's step and
  // the wizard's buttons move the tour.
  const tour = useTour();
  const tourSetup = tour.phase === "setup";

  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const form = useWizardForm();

  // Null until the user touches the grid, so the default selection can follow
  // the key check when it lands.
  const [chosenModelIds, setChosenModelIds] = useState<string[] | null>(null);

  const models = useQuery({ queryKey: ["models"], queryFn: () => listModels() });
  const keys = useQuery({ queryKey: ["key-status"], queryFn: () => fetchKeyStatus() });
  // The live run-size ceiling, so the plan panel warns at the number a first
  // run would be refused at.
  const limits = useQuery({ queryKey: ["call-limit"], queryFn: () => fetchCallLimit() });
  // Only for pricing the extraction call in the estimate; the server picks the
  // extractor itself.
  const extractionModels = useQuery({
    queryKey: ["extraction-models"],
    queryFn: () => listExtractionModels(),
  });
  const worker = useQuery({ queryKey: ["worker-status"], queryFn: () => workerStatus() });

  const tutorial = useQuery({ queryKey: ["tutorial-state"], queryFn: () => fetchTutorialState() });
  const isTutorial = isTutorialMode(tutorial.data);
  const prefill = useQuery({
    queryKey: ["demo-prefill"],
    queryFn: () => fetchDemoPrefill(),
    enabled: isTutorial,
  });
  const [seeded, setSeeded] = useState(false);

  // Opening the tutorial is progress: a launch that closes mid-setup restarts
  // it rather than landing in an empty app. A failed write only means the next
  // launch starts the tutorial over, so it must not break this screen.
  useEffect(() => {
    if (tutorial.data === "not_started") {
      void setTutorial({ data: { state: "in_setup" } }).catch(() => undefined);
    }
  }, [tutorial.data]);

  const { seed } = form;
  useEffect(() => {
    if (!isTutorial || seeded || !prefill.data) return;
    seed(prefill.data);
    setSeeded(true);
  }, [isTutorial, seeded, prefill.data, seed]);

  useEffect(() => {
    if (!isTutorial || chosenModelIds !== null || !models.data) return;
    setChosenModelIds(oneMidPerProvider(models.data));
  }, [isTutorial, chosenModelIds, models.data]);

  // The unfinished setup survives a reload, outside the tutorial: there the
  // form holds the demo's values, filled in and locked.
  const [draftChecked, setDraftChecked] = useState(false);
  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  const { restore, draftFields } = form;
  useEffect(() => {
    if (draftChecked || tutorial.isPending) return;
    setDraftChecked(true);
    if (isTutorial) return;
    const draft = readSetupDraft(browserStorage());
    if (!draft || !draftHasContent(draft)) return;
    restore(draft);
    setStep(draft.step);
    setChosenModelIds(draft.chosenModelIds);
    setRestoredAt(draft.savedAt);
  }, [draftChecked, tutorial.isPending, isTutorial, restore]);

  useEffect(() => {
    if (!draftChecked || isTutorial || !draftHasContent(draftFields)) return;
    writeSetupDraft(browserStorage(), {
      ...draftFields,
      step: step === 1 ? 1 : 0,
      chosenModelIds,
    });
  }, [draftChecked, isTutorial, draftFields, step, chosenModelIds]);

  function startOver() {
    clearSetupDraft(browserStorage());
    restore(EMPTY_WIZARD_DRAFT);
    setChosenModelIds(null);
    setRestoredAt(null);
    setStep(0);
  }

  const keyedProviders = useMemo(
    () => (keys.data ?? []).filter((row) => row.configured).map((row) => String(row.provider)),
    [keys.data],
  );

  // A check that has not landed, or that failed, is not a denial; see
  // lib/availability.ts for the three states.
  const availability = resolveFeature({
    isPending: keys.isPending,
    isError: keys.isError,
    value: keyedProviders.length > 0,
    offReason: NO_KEY_CONFIGURED,
    errorReason: "We could not check which provider keys are in your environment.",
  });

  // One representative model per provider. The create gate below checks the
  // exact models chosen instead.
  const { statuses, check: checkProvider } = useProviderChecks(
    keys.data,
    () => void keys.refetch(),
  );

  const defaultModelIds = useMemo(
    () => defaultAssistantIds(models.data ?? [], keyedProviders),
    [models.data, keyedProviders],
  );
  // A restored draft can name a model the catalogue no longer offers.
  const selectedModelIds = useMemo(() => {
    const ids = chosenModelIds ?? defaultModelIds;
    const catalogue = models.data;
    return catalogue ? ids.filter((id) => catalogue.some((model) => model.id === id)) : ids;
  }, [chosenModelIds, defaultModelIds, models.data]);
  const selectionCheck = useSelectionCheck(selectedModelIds);

  const groups = useMemo(() => {
    const byProvider = new Map<string, CatalogModel[]>();
    for (const model of models.data ?? []) {
      const list = byProvider.get(model.provider);
      if (list) list.push(model);
      else byProvider.set(model.provider, [model]);
    }
    return orderAssistants(byProvider.keys()).map((provider) => ({
      provider,
      models: byProvider.get(provider) ?? [],
    }));
  }, [models.data]);

  const { writtenPrompts } = form;
  const plan = newProjectPlan(writtenPrompts, selectedModelIds.length);

  // Dollars at list prices, from the same totals as the call count. Labelled an
  // estimate wherever it is shown: the run screen logs real spend as it lands.
  const spendEstimate = useMemo(() => {
    const catalogue = models.data ?? [];
    const extractor = pickExtractor(extractionModels.data ?? [], keyedProviders);
    return estimateWizardSpend({
      totalIterations: writtenPrompts.reduce((sum, prompt) => sum + prompt.iterations, 0),
      assistants: selectedModelIds
        .map((id) => catalogue.find((model) => model.id === id))
        .filter((model): model is CatalogModel => model !== undefined)
        .map(modelPrices),
      extractor: extractor ? modelPrices(extractor) : null,
      includePerception: true,
    });
  }, [models.data, extractionModels.data, keyedProviders, writtenPrompts, selectedModelIds]);

  // The model the generate button's call goes to, by the same rule and from
  // the same two lists the server picks from, so the rough cost on the button
  // is priced at the model that is called.
  const generationModel = useMemo(
    () => pickGenerationModel(models.data ?? [], extractionModels.data ?? [], keyedProviders),
    [models.data, extractionModels.data, keyedProviders],
  );
  const generationCost = estimateGenerationCost(
    generationModel,
    starterGenerationChars(form.generationRequest()),
  );
  // Key status gates the button, not the setup check, which gates create. It
  // waits for the key status and both lists, so a key it has not read yet is
  // never shown as missing.
  const generateReady =
    keys.data !== undefined && models.data !== undefined && extractionModels.data !== undefined;
  const generation = generateState({
    generating,
    hasModel: generationModel !== null,
    untouched: form.promptsUntouched,
    source: form.promptSource,
  });

  /**
   * The one shot for this input set. Success replaces the five; any failure
   * leaves the list exactly as it was and re-arms the button, and the toast
   * names the reason the server gave.
   */
  async function generatePrompts() {
    const generatedFor = form.inputs;
    setGenerating(true);
    try {
      const result = await generateStarterPrompts({ data: form.generationRequest() });
      form.applyGenerated(result.prompts, generatedFor);
    } catch (error) {
      toast.error(generationFailedToast(errorText(error, "We could not generate prompts")));
    } finally {
      setGenerating(false);
    }
  }

  function toggleModel(modelId: string, on: boolean) {
    setChosenModelIds(
      on
        ? [...new Set([...selectedModelIds, modelId])]
        : selectedModelIds.filter((id) => id !== modelId),
    );
  }

  /**
   * Create the project, then start its first run. The project exists either
   * way: a run that will not start is reported, and the user lands on the
   * dashboard rather than inside onboarding with a project behind them.
   */
  async function finish() {
    setBusy(true);
    try {
      if (!(await selectionCheck.ensurePassed())) return;

      setCreating(form.brandName.trim());
      const { projectId } = await createProject({ data: form.projectInput(selectedModelIds) });
      clearSetupDraft(browserStorage());

      try {
        const run = await createRun({ data: { projectId } });
        const calls = run.plannedCalls + run.perceptionCalls;
        const answers = toAnswers(run.plannedCalls);
        toast.success(`Run started: ${answers} answers (${calls} provider calls)`);
        if (run.perceptionSkipped) toast.warning(run.perceptionSkipped);
        void navigate({
          to: "/projects/$projectId/runs/$runId",
          params: { projectId, runId: run.runId },
        });
        return;
      } catch (runError) {
        toast.warning(
          errorText(runError, "Your project was created, but we could not start the first run."),
        );
      }

      void navigate({ to: "/projects/$projectId", params: { projectId } });
    } catch (error) {
      toast.error(errorText(error, "We could not create the project"));
      setCreating(null);
    } finally {
      setBusy(false);
    }
  }

  /**
   * The tutorial's last step: build the demo (never a duplicate, never a
   * provider call), mark the tutorial done, arm the tour's results half, and
   * open the demo's showcase run. The server names the run to open on, so the
   * id travels with the armed tour.
   */
  async function finishTutorial() {
    setBusy(true);
    try {
      const { projectId, showcaseRunId } = await restoreDemoProject();
      await setTutorial({ data: { state: "done" } });
      tour.armResults(projectId, showcaseRunId);
      void queryClient.invalidateQueries({ queryKey: ["tutorial-state"] });
      void queryClient.invalidateQueries({ queryKey: ["demo-state"] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["most-recent-project"] });
      void navigate({
        to: "/projects/$projectId/runs/$runId",
        params: { projectId, runId: showcaseRunId },
      });
    } catch (error) {
      toast.error(errorText(error, "Could not create the demo project"));
    } finally {
      setBusy(false);
    }
  }

  if (creating !== null && busy) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
        <Loader2 className="size-5 animate-spin text-primary" />
        <h1 className="type-title">Setting up {creating}</h1>
        <p className="type-meta">
          Creating your project and starting your first run. This takes a moment.
        </p>
      </main>
    );
  }

  if (isTutorial && busy) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
        <Loader2 className="size-5 animate-spin text-primary" />
        <h1 className="type-title">Building the demo</h1>
      </main>
    );
  }

  // The tour's first step rings the brand block; the rest live on screen two.
  const screen = tourSetup ? (tour.index === 0 ? 0 : 1) : step;

  function continueToQuestions() {
    form.advance();
    if (tourSetup) tour.next();
    else setStep(1);
  }

  function backToBrand() {
    if (tourSetup) tour.goTo(0);
    else setStep(0);
  }

  const create = createGate({
    // A create while a generated set is on its way would submit the list it
    // is about to replace.
    busy: busy || generating,
    promptCount: writtenPrompts.length,
    untaggedCount: form.untaggedPrompts.length,
    blankPerception: form.blankPerception,
    selectedCount: selectedModelIds.length,
    checkGate: selectionCheck.gate,
  });

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
      {worker.data?.mockProviders === true && (
        <div className="mb-10">
          <MockProvidersNotice />
        </div>
      )}
      <div className="grid gap-10 lg:grid-cols-[minmax(0,19rem)_minmax(0,40rem)] lg:gap-16">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <StepRail step={screen} />
          <h1 className="type-display mt-6">
            {screen === 0 ? "Which brand are we watching?" : "The prompts buyers ask"}
          </h1>
          {screen === 0 ? (
            <div className="mt-4 space-y-3">
              <p className="type-meta">
                Name variants decide what counts as naming you, and domains decide what counts as
                citing you. Domains also tell your brand apart from a company that shares your name.
              </p>
              <p className="type-meta">
                The brand name is fixed for this project. Domains and name variants stay editable in
                Project settings.
              </p>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <p className="type-meta">
                Edit these to sound like your real buyers. You can add more, and change how many
                times each one runs, once you are in.
              </p>
              <p className="type-meta">
                Nothing is asked until you press the button at the end
                {isTutorial ? "." : ", and the panel above it says what that will cost."}
              </p>
            </div>
          )}
          <p className="type-meta mt-10 max-w-xs border-t border-border pt-5">
            Local first. Your brands, prompts and answers are written to a SQLite file on this
            machine, and the only calls that leave it are to the assistants you pick, on your own
            keys.
          </p>
        </div>

        <div>
          {restoredAt !== null && !isTutorial && (
            <p className="type-meta mb-6">
              Restored what you typed before.{" "}
              <button type="button" className="text-primary underline" onClick={startOver}>
                Start over
              </button>
            </p>
          )}

          {screen === 0 && !isTutorial && availability.state === "off" && (
            <section className="mb-10 space-y-3" aria-labelledby="first-key">
              <h2 id="first-key" className="type-section">
                First, add a provider key
              </h2>
              <p className="type-meta">
                Overheard AI asks the assistants on your own API keys, so it needs at least one
                before anything can run. Add it to the .env file in the app's folder, then press
                Check again. There is no need to restart, and what you type below is kept.
              </p>
              <KeyStatusList
                statuses={statuses}
                onCheck={(p) => void checkProvider(p)}
                onRecheckKeys={() => void keys.refetch()}
                showChecks={false}
                tourId={null}
              />
            </section>
          )}

          {screen === 0 && (
            <WizardBrandStep form={form} locked={isTutorial} onContinue={continueToQuestions} />
          )}

          {screen === 1 && (
            <section className="space-y-8">
              <div className="space-y-4">
                <WizardPromptList form={form} locked={isTutorial} busy={generating} />
                <WizardPromptDoors
                  button={
                    !isTutorial && generateReady
                      ? {
                          state: generation,
                          costUsd: generationCost,
                          onGenerate: () => void generatePrompts(),
                        }
                      : null
                  }
                />
              </div>

              <fieldset disabled={isTutorial} className="block">
                {isTutorial && <LockLine />}
                <PerceptionPromptCard
                  value={form.perceptionPrompt}
                  edited={form.perceptionDirty}
                  onChange={form.editPerception}
                  onReset={form.resetPerception}
                />
              </fieldset>

              {!isTutorial && selectedModelIds.length > 0 && writtenPrompts.length > 0 && (
                <RunPlanSummary
                  plan={{ ...plan, estimateUsd: spendEstimate }}
                  maxCalls={limits.data?.limit}
                />
              )}

              <div className="space-y-3">
                <h2 className="type-section">Who answers them</h2>
                <KeyStatusList
                  statuses={statuses}
                  onCheck={(p) => void checkProvider(p)}
                  onRecheckKeys={() => void keys.refetch()}
                  showChecks={!isTutorial}
                  tourId={TOUR_SELECTORS.wizardKeys}
                />
                {!isTutorial && (
                  <AvailabilityNotice
                    availability={availability}
                    onRetry={() => void keys.refetch()}
                  />
                )}
                {(availability.state === "on" || isTutorial) && (
                  <WizardAssistantPicker
                    groups={groups}
                    keyedProviders={keyedProviders}
                    selectedModelIds={selectedModelIds}
                    onToggle={toggleModel}
                    locked={isTutorial}
                  />
                )}
              </div>

              {!isTutorial && selectedModelIds.length > 0 && (
                <WizardSetupCheckPanel check={selectionCheck} />
              )}

              <div className="space-y-3 border-t border-border pt-6">
                {isTutorial ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="lg"
                      onClick={() => void finishTutorial()}
                      disabled={busy}
                      data-tour={TOUR_SELECTORS.wizardCreate}
                    >
                      {busy ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Sparkles className="size-4" />
                      )}
                      Open the demo project
                    </Button>
                    <Button variant="ghost" size="lg" onClick={backToBrand}>
                      Back
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="lg" onClick={() => void finish()} disabled={!create.enabled}>
                        {busy ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Play className="size-4" />
                        )}
                        Create project and run
                      </Button>
                      <Button
                        variant="ghost"
                        size="lg"
                        onClick={() => setStep(0)}
                        disabled={generating}
                      >
                        Back
                      </Button>
                    </div>
                    {create.hint && <p className="type-meta">{create.hint}</p>}
                  </>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * The two steps as a rail. The line between the nodes fills once step one is
 * behind you.
 */
function StepRail({ step }: { step: number }) {
  const STEPS = ["Your brand", "Questions and assistants"];
  return (
    <ol className="space-y-1">
      {STEPS.map((label, index) => {
        const done = index < step;
        const current = index === step;
        return (
          <li key={label} className="flex items-center gap-3">
            <span className="flex flex-col items-center self-stretch">
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${
                  current ? "bg-primary" : done ? "bg-primary/50" : "bg-smoke"
                }`}
              />
              {index < STEPS.length - 1 && (
                <span
                  aria-hidden="true"
                  className={`w-px flex-1 ${done ? "bg-primary/50" : "bg-border"}`}
                  style={{ minHeight: 18 }}
                />
              )}
            </span>
            <span
              className={`py-0.5 text-sm ${current ? "font-medium text-foreground" : "text-muted-foreground"}`}
              aria-current={current ? "step" : undefined}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

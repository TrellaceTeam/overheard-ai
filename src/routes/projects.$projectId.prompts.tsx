import { createFileRoute, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, Plus, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DemoReadOnlyNote, DEMO_READONLY_REASON } from "@/components/DemoReadOnlyNote";
import { useIsDemo } from "@/components/useIsDemo";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DeletePromptDialog } from "@/components/DeletePromptDialog";
import { PromptCard } from "@/components/PromptCard";
import { PromptResultsSummaryFold } from "@/components/PromptResultsSummaryFold";
import { Runner } from "@/components/Runner";
import { TagChip, TagPicker } from "@/components/TagPicker";
import { errorText } from "@/lib/error-text";
import { answerCountLabel, groupByTag } from "@/lib/prompt-groups";
import {
  clonePrompt,
  createPrompt,
  deletePrompt,
  listPrompts,
  promptAnswerCounts,
  setPromptArchived,
  updatePrompt,
} from "@/server/api/prompts";
import { listPromptResultsSummaries, summarizePromptResults } from "@/server/api/prompt-results";

/**
 * Owns the prompt library (the questions a run asks, their tags, how many times
 * each one repeats, and which are locked) and the Runner above it, where the
 * next run is decided and started.
 *
 * A prompt is on or off (asked on the next run or kept for later), and it can
 * be archived: out of sight in the fold at the bottom, never asked, its answers
 * kept and still counted. Delete is destructive. The answers go with the prompt
 * and its runs are re-scored without them, so the screen asks first and offers
 * archiving instead.
 *
 * A question that already has answers cannot have its text edited, because
 * that would silently change what every past run measured. The escape hatch is
 * a clone: the same wording as a starting point, switched off, so the next run
 * does not ask both.
 */
export const Route = createFileRoute("/projects/$projectId/prompts")({
  head: () => ({
    meta: [
      { title: "Prompts - Overheard AI" },
      { name: "description", content: "The buyer prompts asked of each assistant on every run." },
    ],
  }),
  component: Prompts,
});

export const ALL = "all";
export const UNTAGGED = "__untagged__";

/** Mirrors the length CHECK on prompts.text and the server's input schema. */
const PROMPT_MAX_CHARS = 2000;

export interface PromptFilters {
  status: "all" | "active" | "inactive";
  /** A tag name, or ALL, or UNTAGGED. */
  tag: string;
  answers: "all" | "has" | "none";
}

/**
 * Whether one prompt survives the filter strip.
 *
 * The three filters compose in a way that is easy to get subtly wrong:
 * "Untagged" is a tag choice, not the absence of one, and a blank tag counts as
 * untagged, matching groupByTag.
 */
export function matchesFilters(
  prompt: { category: string | null; is_active: number },
  answers: number,
  filters: PromptFilters,
): boolean {
  const active = prompt.is_active === 1;
  if (filters.status === "active" && !active) return false;
  if (filters.status === "inactive" && active) return false;

  const tagged = Boolean(prompt.category?.trim());
  if (filters.tag === UNTAGGED) {
    if (tagged) return false;
  } else if (filters.tag !== ALL && prompt.category !== filters.tag) {
    return false;
  }

  if (filters.answers === "has" && answers === 0) return false;
  if (filters.answers === "none" && answers > 0) return false;
  return true;
}

/**
 * Whether the new-prompt form may submit: a question and a tag, because the
 * server refuses to create one without either.
 */
export function canAddPrompt(text: string, tag: string | null): boolean {
  return text.trim() !== "" && tag !== null;
}

/**
 * The inactive prompts the server would refuse to switch on: their text still
 * matches another prompt in the project, trimmed and case-insensitively,
 * archived rows included.
 *
 * A hint, not the rule. The server compares with SQLite's ASCII-only `lower()`
 * and this with JS's Unicode-aware `toLowerCase()`, so on non-ASCII casing the
 * hint can show for a switch the server would accept. A missed hint still ends
 * in a readable refusal toast.
 */
export function identicalInactiveIds(
  prompts: { id: string; text: string; is_active: number }[],
): Set<string> {
  const seen = new Map<string, number>();
  for (const prompt of prompts) {
    const key = prompt.text.trim().toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const ids = new Set<string>();
  for (const prompt of prompts) {
    if (prompt.is_active === 0 && (seen.get(prompt.text.trim().toLowerCase()) ?? 0) > 1) {
      ids.add(prompt.id);
    }
  }
  return ids;
}

function Prompts() {
  const { projectId } = useParams({ from: "/projects/$projectId/prompts" });
  const isDemo = useIsDemo(projectId);
  const queryClient = useQueryClient();

  const [text, setText] = useState("");
  const [iterations, setIterations] = useState(5);
  const [tag, setTag] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [tagFilter, setTagFilter] = useState(ALL);
  const [answersFilter, setAnswersFilter] = useState<"all" | "has" | "none">("all");
  const [archivedOpen, setArchivedOpen] = useState(false);
  // The prompt the delete dialog is asking about, and whether it is already
  // archived, since an archived prompt has no "Archive instead" to offer.
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    text: string;
    archived: boolean;
    answers: number;
  } | null>(null);

  const prompts = useQuery({
    queryKey: ["prompts", projectId],
    queryFn: () => listPrompts({ data: { projectId } }),
  });

  // Answers per prompt, counted from run_tasks. A counter column on prompts
  // would drift the first time a run was deleted.
  const answerCounts = useQuery({
    queryKey: ["prompt-answer-counts", projectId],
    queryFn: () => promptAnswerCounts({ data: { projectId } }),
  });

  // One fold per prompt with answers: what a summary across its runs would
  // read and cost, and the stored one if it was bought. A prompt without
  // answers has no row here, and so no fold.
  const resultsSummaries = useQuery({
    queryKey: ["prompt-results-summaries", projectId],
    queryFn: () => listPromptResultsSummaries({ data: { projectId } }),
  });
  const summaryFor = useMemo(
    () => new Map((resultsSummaries.data ?? []).map((row) => [row.promptId, row])),
    [resultsSummaries.data],
  );
  const [summarizing, setSummarizing] = useState<string | null>(null);

  const counts = answerCounts.data ?? {};
  const answersFor = (promptId: string) => counts[promptId] ?? 0;

  const rows = prompts.data ?? [];
  // The library is the main list and the archive is the fold at the bottom.
  // Both keep their answers, and both count in the statistics.
  const library = rows.filter((prompt) => prompt.archived === 0);
  const archivedRows = rows.filter((prompt) => prompt.archived === 1);

  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const prompt of library) if (prompt.category) set.add(prompt.category);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [library]);

  const visible = library.filter((prompt) =>
    matchesFilters(prompt, answersFor(prompt.id), {
      status: statusFilter,
      tag: tagFilter,
      answers: answersFilter,
    }),
  );

  const groups = useMemo(() => groupByTag(visible), [visible]);
  // Computed over every row, archived included: a hidden twin still blocks the
  // switch on the server, so the hint must not miss it.
  const identical = useMemo(() => identicalInactiveIds(rows), [rows]);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["prompts", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["run-plan", projectId] });
  }

  /** Every write on this screen reports its own refusal in the same voice. */
  async function attempt(work: () => Promise<unknown>, success?: string) {
    try {
      await work();
      if (success) toast.success(success);
      refresh();
    } catch (error) {
      toast.error(errorText(error, "That did not save"));
    }
  }

  async function add() {
    // The Add button is disabled without both. The `!tag` check narrows the
    // type for createPrompt.
    if (!canAddPrompt(text, tag) || !tag) return;
    await attempt(
      () =>
        createPrompt({
          data: { projectId, text: text.trim(), iterations, category: tag },
        }),
      "Prompt added",
    );
    // The text clears and the tag stays, because the next question usually
    // sits under the same one.
    setText("");
  }

  async function patch(
    id: string,
    data: { text?: string; isActive?: boolean; iterations?: number; category?: string | null },
  ) {
    await attempt(() => updatePrompt({ data: { id, ...data } }));
  }

  async function clone(id: string) {
    await attempt(() => clonePrompt({ data: { id } }), "Cloned as an editable copy, switched off");
  }

  async function archive(id: string) {
    await attempt(
      () => setPromptArchived({ data: { id, archived: true } }),
      // A prompt with no answers has nothing to reassure about.
      (counts[id] ?? 0) > 0 ? "Archived. Its answers stay and keep counting" : "Archived",
    );
  }

  async function restore(id: string) {
    await attempt(() => setPromptArchived({ data: { id, archived: false } }), "Restored");
  }

  async function remove(id: string) {
    await attempt(
      () => deletePrompt({ data: { id } }),
      "Prompt deleted. Its answers went with it, and its runs were re-scored",
    );
  }

  /**
   * Buy one prompt's results summary. The fold shows the rough cost before
   * this is reachable, the server stores the result, and the refetch renders
   * it in the fold, flag cleared.
   */
  async function summarize(promptId: string) {
    setSummarizing(promptId);
    try {
      await summarizePromptResults({ data: { promptId } });
      toast.success("Summary saved");
      void queryClient.invalidateQueries({ queryKey: ["prompt-results-summaries", projectId] });
    } catch (error) {
      toast.error(errorText(error, "Could not summarize those answers"));
    } finally {
      setSummarizing(null);
    }
  }

  /** The fold for a prompt with answers; nothing for one without. */
  function resultsFold(promptId: string) {
    const row = summaryFor.get(promptId);
    if (!row) return null;
    return (
      <PromptResultsSummaryFold
        row={row}
        busy={summarizing === promptId}
        locked={isDemo ? DEMO_READONLY_REASON : null}
        onAsk={() => void summarize(promptId)}
      />
    );
  }

  return (
    <div className="space-y-6">
      {isDemo && <DemoReadOnlyNote />}

      <Runner projectId={projectId} locked={isDemo ? DEMO_READONLY_REASON : null} prompts={rows} />

      <section className="space-y-3">
        <h2 className="type-section">New prompt</h2>
        <div className="panel space-y-4 p-5">
          <fieldset disabled={isDemo} className="space-y-4 disabled:opacity-60">
            <div className="space-y-2">
              <Textarea
                id="new-prompt"
                aria-label="New prompt"
                rows={2}
                maxLength={PROMPT_MAX_CHARS}
                value={text}
                placeholder="What is the best analytics tool for a small marketing team?"
                onChange={(e) => setText(e.target.value)}
              />
              <p className="num text-right text-xs text-muted-foreground">
                {text.length} / {PROMPT_MAX_CHARS}
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-2">
                <Label htmlFor="iterations">Iterations</Label>
                <Input
                  id="iterations"
                  type="number"
                  min={1}
                  max={20}
                  className="num w-24"
                  value={iterations}
                  onChange={(e) => setIterations(Number(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label>Tag</Label>
                <TagPicker value={tag} tags={tags} onChange={setTag} />
              </div>
              <Button onClick={() => void add()} disabled={!canAddPrompt(text, tag)}>
                <Plus className="size-4" /> Add prompt
              </Button>
            </div>
            <p className="type-meta max-w-prose">
              Iterations are repeats per assistant. Assistants are not deterministic, so a single
              answer tells you almost nothing.
            </p>
          </fieldset>
        </div>
      </section>

      <div className="panel flex flex-wrap items-end gap-3 p-4">
        <div className="w-full space-y-2 sm:w-auto">
          <Label>Status</Label>
          <Select
            value={statusFilter}
            onValueChange={(value) => setStatusFilter(value as "all" | "active" | "inactive")}
          >
            <SelectTrigger className="w-40" aria-label="Status filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All prompts</SelectItem>
              <SelectItem value="active">On only</SelectItem>
              <SelectItem value="inactive">Off only</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Tag</Label>
          <Select value={tagFilter} onValueChange={setTagFilter}>
            <SelectTrigger className="w-44" aria-label="Tag filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All tags</SelectItem>
              <SelectItem value={UNTAGGED}>Untagged</SelectItem>
              {tags.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Answers</Label>
          <Select
            value={answersFilter}
            onValueChange={(value) => setAnswersFilter(value as "all" | "has" | "none")}
          >
            <SelectTrigger className="w-40" aria-label="Answers filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any</SelectItem>
              <SelectItem value="has">Has answers</SelectItem>
              <SelectItem value="none">No answers yet</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="num ml-auto text-xs text-muted-foreground">
          Showing {visible.length} of {library.length}
        </p>
      </div>

      <div className="space-y-6">
        {visible.length === 0 &&
          (prompts.isPending ? (
            <p className="panel num type-meta p-5">Reading your prompts…</p>
          ) : prompts.isError ? (
            <p className="panel type-meta p-5">
              We could not load your prompts just now. Reload to try again.
            </p>
          ) : library.length === 0 ? (
            <p className="panel type-meta max-w-prose p-5">
              No prompts yet. Write one in New prompt above.
            </p>
          ) : (
            <div className="panel flex flex-wrap items-center gap-3 p-5">
              <p className="type-meta max-w-prose">No prompts match these filters.</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStatusFilter("all");
                  setTagFilter(ALL);
                  setAnswersFilter("all");
                }}
              >
                Clear filters
              </Button>
            </div>
          ))}

        {groups.map((group) => (
          <section key={group.tag ?? UNTAGGED} className="space-y-3">
            {/* The group heading wears the same chip as its cards, static: the
                colour that groups the library visually is the colour of the
                tag, and heading navigation keeps a real heading. */}
            <div className="flex items-center gap-2">
              <h2 className="type-section flex items-center gap-2">
                <TagChip tag={group.tag} />
              </h2>
              <span className="num type-meta">
                {group.prompts.length} prompt{group.prompts.length === 1 ? "" : "s"}
              </span>
            </div>

            {group.prompts.map((prompt) => (
              <PromptCard
                key={prompt.id}
                prompt={prompt}
                answers={answersFor(prompt.id)}
                isDemo={isDemo}
                identical={identical.has(prompt.id)}
                tags={tags}
                maxChars={PROMPT_MAX_CHARS}
                onPatch={(id, data) => void patch(id, data)}
                onClone={(id) => void clone(id)}
                onArchive={(id) => void archive(id)}
                onDelete={(id) =>
                  setPendingDelete({
                    id,
                    text: prompt.text,
                    archived: false,
                    answers: answersFor(prompt.id),
                  })
                }
                resultsFold={resultsFold(prompt.id)}
              />
            ))}
          </section>
        ))}

        {archivedRows.length > 0 && (
          <section className="space-y-3">
            <button
              type="button"
              className="flex items-center gap-2 py-0.5 text-sm text-muted-foreground hover:text-foreground"
              onClick={() => setArchivedOpen(!archivedOpen)}
            >
              <Archive className="size-4" />
              Archived prompts
              <span className="num type-meta">{archivedRows.length}</span>
              <span aria-hidden="true">{archivedOpen ? "▾" : "▸"}</span>
            </button>
            {archivedOpen && (
              <>
                {archivedRows.map((prompt) => (
                  <div key={prompt.id} className="panel flex flex-wrap items-center gap-3 p-4">
                    <p className="line-clamp-2 min-w-0 flex-1 text-sm text-muted-foreground">
                      {prompt.text}
                    </p>
                    <span className="num text-xs text-muted-foreground">
                      {answerCountLabel(counts[prompt.id])}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => void restore(prompt.id)}>
                      <Undo2 className="size-4" /> Restore
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() =>
                        setPendingDelete({
                          id: prompt.id,
                          text: prompt.text,
                          archived: true,
                          answers: answersFor(prompt.id),
                        })
                      }
                    >
                      <Trash2 className="size-4" /> Delete
                    </Button>
                    {/* Archived answers keep counting, so they keep their
                        summary too, on a line of its own under the row. */}
                    {summaryFor.has(prompt.id) && (
                      <div className="basis-full">{resultsFold(prompt.id)}</div>
                    )}
                  </div>
                ))}
                <p className="type-meta max-w-prose">
                  Archived prompts are never asked, and their answers stay in your statistics.
                  Restore one to bring it back with the on/off state it had.
                </p>
              </>
            )}
          </section>
        )}
      </div>

      <DeletePromptDialog
        prompt={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onArchive={(id) => {
          setPendingDelete(null);
          void archive(id);
        }}
        onDelete={(id) => {
          setPendingDelete(null);
          void remove(id);
        }}
      />
    </div>
  );
}

import { useState } from "react";
import { ChevronDown, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppLink } from "@/components/AppLink";
import type { FailedTask } from "@/components/types";
import {
  classifyFailure,
  groupFailures,
  OWNER_LABEL,
  type FailureGroup,
  type FaultOwner,
} from "@/lib/failure-reasons";
import { toStoredFailure } from "@/lib/failure-codes";

const OWNER_STYLE: Record<FaultOwner, string> = {
  // Warn amber, not the primary green: "Yours to fix" is an action notice on a
  // failure card, and the brand green reads as success. Same --warn token the
  // perception band and key notices use for "needs your attention".
  you: "border-warn/40 text-warn",
  provider: "border-border text-muted-foreground",
  us: "border-destructive/40 text-destructive",
  stopped: "border-border text-muted-foreground",
};

function OwnerChip({ owner }: { owner: FaultOwner }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${OWNER_STYLE[owner]}`}
    >
      {OWNER_LABEL[owner]}
    </span>
  );
}

/** Does this reason point the user at their provider keys? */
function needsSettings(group: FailureGroup): boolean {
  return group.owner === "you";
}

function GroupCard({ group, tasks }: { group: FailureGroup; tasks: FailedTask[] }) {
  const [open, setOpen] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const mine = tasks.filter((task) => classifyFailure(toStoredFailure(task)).key === group.key);

  return (
    <article className="panel space-y-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {group.count} {group.count === 1 ? "answer" : "answers"}: {group.title}
        </span>
        {/* A null owner is the chip-less failure: an answer no reader could
            parse has no useful fault owner, and naming one would be a lecture
            the card's own Retry button contradicts. */}
        {group.owner !== null && <OwnerChip owner={group.owner} />}
      </div>
      <p className="text-sm text-muted-foreground">{group.advice}</p>

      {needsSettings(group) && (
        // Keys come from the environment, so they are the machine's business:
        // Account settings, not this project's.
        <AppLink to="/settings" className="inline-block text-sm text-primary underline">
          Open Account settings
        </AppLink>
      )}

      <div className="flex flex-wrap gap-4 pt-1 text-xs">
        <button
          type="button"
          className="inline-flex items-center gap-1 py-1 text-muted-foreground hover:text-foreground"
          onClick={() => setOpen(!open)}
        >
          <ChevronDown className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
          {open ? "Hide the affected prompts" : "Which prompts"}
        </button>
        {!group.isHtml && group.detail && (
          <button
            type="button"
            className="py-1 text-muted-foreground hover:text-foreground"
            onClick={() => setShowDetail(!showDetail)}
          >
            {showDetail ? "Hide technical detail" : "Technical detail"}
          </button>
        )}
      </div>

      {open && (
        <ul className="space-y-1 border-l-2 border-border pl-3 text-xs text-muted-foreground">
          {mine.map((task) => (
            <li key={task.id} className="truncate">
              {task.question_text ?? task.prompt_text ?? "Question not recorded"}
              <span className="num ml-2">
                #{task.iteration} · {task.model_name ?? "Unknown model"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {showDetail && !group.isHtml && (
        <p className="num line-clamp-2 rounded bg-muted/40 p-2 text-[11px] text-muted-foreground">
          {group.detail}
        </p>
      )}

      {group.isHtml && (
        <p className="text-xs text-muted-foreground">
          The provider returned an error page rather than a message, so there is no readable detail
          to show.
        </p>
      )}
    </article>
  );
}

/**
 * Grouped, plain-English list of everything that failed in a run. The grouping
 * and wording come from lib/failure-reasons, and the route wires the retry to
 * the server.
 */
export function RunFailures({
  tasks,
  onRetry,
  retrying = false,
  locked = null,
}: {
  tasks: FailedTask[];
  /** Queues the failed calls again. The route owns the server call and the toast. */
  onRetry: () => void;
  retrying?: boolean | undefined;
  /** When set, retrying is unavailable and this says why (the demo project). */
  locked?: string | null | undefined;
}) {
  if (tasks.length === 0) return null;
  const groups = groupFailures(tasks.map(toStoredFailure));

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="type-section">Calls that failed</h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={retrying || locked !== null}
          title={locked ?? undefined}
          onClick={onRetry}
        >
          {retrying ? (
            <Loader2 className="mr-2 size-3.5 animate-spin" />
          ) : (
            <RotateCcw className="mr-2 size-3.5" />
          )}
          {/* Counted in answers, like the progress bar, the run list and the
              plan. One run_tasks row is one answer. Only the stored call
              counters are doubled. */}
          {retrying
            ? "Queueing"
            : `Retry ${tasks.length} failed ${tasks.length === 1 ? "answer" : "answers"}`}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Only the answers that failed are collected again, on your own keys. Answers already in are
        kept, and one that failed while being scored is only scored again rather than asked again.
      </p>
      {groups.map((group) => (
        <GroupCard key={group.key} group={group} tasks={tasks} />
      ))}
    </section>
  );
}

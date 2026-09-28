import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PromptOption } from "@/components/types";
import {
  assistantLabel,
  PERIODS,
  type DashboardFilter,
  type Period,
} from "@/lib/dashboard-filters";

/**
 * The dashboard filter strip: assistants, period, prompt, and the line that
 * says which filter emptied the page.
 *
 * It sits above everything, not beside a chart, because every filter applies
 * to every number on the dashboard. A control's position is a claim about its
 * scope.
 */
export function DashboardFilters({
  filter,
  allAssistants,
  prompts,
  notice,
  onAssistantToggle,
  onPeriodChange,
  onPromptChange,
}: {
  filter: DashboardFilter;
  allAssistants: string[];
  prompts: PromptOption[];
  notice: string | null;
  onAssistantToggle: (provider: string, on: boolean) => void;
  onPeriodChange: (period: Period) => void;
  onPromptChange: (promptId: string) => void;
}) {
  // null means every assistant, including any added after this render.
  const selected = filter.assistants ?? allAssistants;
  const assistantSummary =
    filter.assistants === null
      ? "All assistants"
      : selected.length === 0
        ? "No assistants"
        : selected.length <= 2
          ? selected.map(assistantLabel).join(", ")
          : `${selected.length} assistants`;

  return (
    <div className="panel space-y-2 p-3">
      {/* Each control keeps one width at each breakpoint: full width on a
          phone, so the three stacked controls line up, and a fixed width
          from sm up. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="type-label mr-1 flex items-center gap-1.5">
          <SlidersHorizontal className="size-3.5" />
          Filters
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start font-normal sm:w-40"
            >
              {assistantSummary}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {allAssistants.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No assistants are switched on for this project.
              </div>
            )}
            {allAssistants.map((provider) => (
              <DropdownMenuCheckboxItem
                key={provider}
                checked={selected.includes(provider)}
                onCheckedChange={(checked) => onAssistantToggle(provider, checked)}
              >
                {assistantLabel(provider)}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Select value={filter.period} onValueChange={(value) => onPeriodChange(value as Period)}>
          <SelectTrigger className="h-8 w-full text-xs sm:w-40" aria-label="Period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((period) => (
              <SelectItem key={period.value} value={period.value}>
                {period.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filter.promptId} onValueChange={onPromptChange}>
          <SelectTrigger className="h-8 w-full text-xs sm:w-56" aria-label="Prompt">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All prompts</SelectItem>
            {prompts.map((prompt) => (
              <SelectItem key={prompt.id} value={prompt.id}>
                {prompt.text.length > 60 ? `${prompt.text.slice(0, 60)}…` : prompt.text}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {notice && <p className="max-w-prose text-xs text-warn">{notice}</p>}
    </div>
  );
}

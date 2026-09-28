import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MenuItem, ProviderMenu } from "@/lib/assistant-menu";
import { assistantLabel } from "@/lib/dashboard-filters";
import { providerLabel } from "@/lib/failure-reasons";
import { keyEnvNamesSafe } from "@/lib/provider-keys";

/**
 * Which assistants a run asks: one dropdown per provider, a checkbox per model,
 * current models first and the ones they replaced below. The rows come from
 * lib/assistant-menu, which owns every rule about what may be ticked.
 *
 * The list holds catalogue models only. A provider offers more, but only these
 * have been checked to answer with web search in the shape a run reads.
 */
export function AssistantPicker({
  menus,
  locked,
  onToggle,
  note = null,
}: {
  menus: readonly ProviderMenu[];
  /** True on the demo and in the tutorial: the menus show the choice but take no change. */
  locked: boolean;
  onToggle: (modelId: string, on: boolean) => void;
  /** A line under the rows, such as the key check still running. */
  note?: string | null | undefined;
}) {
  return (
    <div className="space-y-3">
      {menus.map((menu) => (
        <div key={menu.provider} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="type-label w-20 shrink-0">{assistantLabel(menu.provider)}</span>
          {menu.noKey && !menu.anyChecked ? (
            <p className="text-xs text-muted-foreground">
              No {providerLabel(menu.provider)} key. Add{" "}
              {keyEnvNamesSafe(menu.provider) ?? "its API key"} to your .env file to ask it. There
              is no need to restart.
            </p>
          ) : (
            <ProviderDropdown menu={menu} locked={locked} onToggle={onToggle} />
          )}
          {menu.noKey && menu.anyChecked && !locked && (
            <p className="basis-full pl-[5.75rem] text-xs text-muted-foreground">
              No {providerLabel(menu.provider)} key, so this will fail until you add one or switch
              it off.
            </p>
          )}
          {menu.listProblem && (
            <p className="basis-full pl-[5.75rem] text-xs text-muted-foreground">
              {menu.listProblem}
            </p>
          )}
        </div>
      ))}
      {note && <p className="pl-[5.75rem] text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function ProviderDropdown({
  menu,
  locked,
  onToggle,
}: {
  menu: ProviderMenu;
  locked: boolean;
  onToggle: (modelId: string, on: boolean) => void;
}) {
  const current = menu.items.filter((item) => !item.older);
  const older = menu.items.filter((item) => item.older);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={locked}
          aria-label={`${assistantLabel(menu.provider)} models: ${menu.summary}`}
          className="w-full justify-between font-normal sm:w-72"
        >
          <span className="truncate">{menu.summary}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel className="type-label">Current</DropdownMenuLabel>
        {current.map((item) => (
          <ModelItem key={item.id} item={item} onToggle={onToggle} />
        ))}
        {older.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="type-label">Older, kept for past runs</DropdownMenuLabel>
            {older.map((item) => (
              <ModelItem key={item.id} item={item} onToggle={onToggle} />
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          Only models checked to answer with web search are listed.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelItem({
  item,
  onToggle,
}: {
  item: MenuItem;
  onToggle: (modelId: string, on: boolean) => void;
}) {
  return (
    <DropdownMenuCheckboxItem
      checked={item.checked}
      disabled={item.disabled}
      // The menu stays open, so several models can be ticked in one go.
      onSelect={(event) => event.preventDefault()}
      onCheckedChange={(value) => onToggle(item.id, value === true)}
    >
      <span className="flex-1">{item.label}</span>
      <span className="ml-4 text-xs text-muted-foreground">{item.note ?? item.tier}</span>
    </DropdownMenuCheckboxItem>
  );
}

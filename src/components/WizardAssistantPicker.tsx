import { LockLine } from "@/components/LockLine";
import { Checkbox } from "@/components/ui/checkbox";
import { assistantLabel } from "@/lib/dashboard-filters";
import type { listModels } from "@/server/api/models";

export type CatalogModel = Awaited<ReturnType<typeof listModels>>[number];

/** The catalogue grouped by provider, one checkbox per model. A provider with no key cannot be ticked. */
export function WizardAssistantPicker({
  groups,
  keyedProviders,
  selectedModelIds,
  onToggle,
  locked,
}: {
  groups: ReadonlyArray<{ provider: string; models: CatalogModel[] }>;
  keyedProviders: readonly string[];
  selectedModelIds: readonly string[];
  onToggle: (modelId: string, on: boolean) => void;
  locked: boolean;
}) {
  return (
    <fieldset disabled={locked} className="block">
      {locked && <LockLine />}
      <div className="space-y-4">
        {groups.map((group) => {
          const hasKey = keyedProviders.includes(group.provider);
          return (
            <div key={group.provider} className="space-y-2">
              <p className="type-label">
                {assistantLabel(group.provider)}
                {hasKey ? "" : " (no key in your environment)"}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {group.models.map((model) => (
                  <label
                    key={model.id}
                    className={`panel flex items-center gap-3 p-3 text-sm ${
                      hasKey ? "" : "cursor-not-allowed opacity-50"
                    }`}
                  >
                    <Checkbox
                      checked={selectedModelIds.includes(model.id)}
                      disabled={!hasKey}
                      aria-label={model.display_name}
                      onCheckedChange={(value) => onToggle(model.id, value === true)}
                    />
                    <span className="flex-1">{model.display_name}</span>
                    <span className="num type-label">{model.tier}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

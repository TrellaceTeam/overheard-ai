import { BadgeInput } from "@/components/BadgeInput";
import { LockLine } from "@/components/LockLine";
import { TOUR_SELECTORS } from "@/components/TutorialTour";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { WizardForm } from "@/components/useWizardForm";
import { DESCRIPTION_MAX_CHARS } from "@/lib/onboarding";

/**
 * Step one: the brand, what it does, how it is spelled, where it lives, and
 * who it competes with.
 */
export function WizardBrandStep({
  form,
  locked,
  onContinue,
}: {
  form: WizardForm;
  /** The tutorial fills these fields and locks them. Continue stays usable. */
  locked: boolean;
  onContinue: () => void;
}) {
  const { badDomains, badCompetitorDomains, usableDomains } = form;
  return (
    <section className="space-y-5">
      <fieldset disabled={locked} className="space-y-5" data-tour={TOUR_SELECTORS.wizardBrand}>
        {locked && <LockLine />}
        <div className="space-y-2">
          <Label htmlFor="brand">Brand name (required)</Label>
          <Input
            id="brand"
            value={form.brandName}
            onChange={(e) => form.setBrandName(e.target.value)}
          />
          <p className="min-h-4 text-xs text-muted-foreground">
            Written the way you write it yourself. Other spellings go in Name variants below.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="category">Category (required)</Label>
          <Input
            id="category"
            placeholder="CRM software"
            value={form.category}
            onChange={(e) => form.setCategory(e.target.value)}
          />
          <p className="min-h-4 text-xs text-muted-foreground">
            {form.category.trim() === ""
              ? "The starter prompts on the next step are written around it."
              : ""}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">What does your brand do? (optional)</Label>
          <Textarea
            id="description"
            rows={2}
            maxLength={DESCRIPTION_MAX_CHARS}
            value={form.description}
            onChange={(e) => form.setDescription(e.target.value)}
            className="resize-none"
          />
          <p className="min-h-4 text-xs text-muted-foreground">
            One sentence: what you do, for whom, and where. It sharpens the generated prompts.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="variants">Name variants</Label>
          <BadgeInput
            id="variants"
            value={form.variants}
            onChange={form.setVariants}
            placeholder="Acme, Acme Analytics, AcmeHQ"
            hint="Every spelling an assistant might use for you. Each one counts as naming you."
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="domains">Domains (required)</Label>
          <BadgeInput
            id="domains"
            value={form.domains}
            onChange={form.setDomains}
            onDraftChange={form.setDomainDraft}
            placeholder="acme.example.com"
            hint={
              badDomains.length > 0 ? (
                <span className="text-warn">
                  {badDomains.join(", ")} {badDomains.length === 1 ? "does" : "do"} not look like a
                  domain. Use the form acme.example.com.
                </span>
              ) : usableDomains.length === 0 ? (
                "A citation is an answer that links one of your domains, so with none on file your citation rate can only ever be 0%."
              ) : null
            }
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="competitors">Competitors (up to 3, optional)</Label>
          <BadgeInput
            id="competitors"
            value={form.competitors}
            onChange={form.setCompetitors}
            onDraftChange={form.setCompetitorDraft}
            placeholder="Northwind Metrics, Contoso Insights, Globex Search"
            maxItems={3}
            hint={
              badCompetitorDomains.length > 0 ? (
                <span className="text-warn">
                  {badCompetitorDomains.map((entry) => `${entry.name}: ${entry.domain}`).join(", ")}{" "}
                  {badCompetitorDomains.length === 1 ? "does" : "do"} not look like a domain. Use
                  the form acme.example.com.
                </span>
              ) : (
                "Optional, but a competitor with no domain can be named and never cited. Add a domain below and their citations count from the first run."
              )
            }
          />
          {form.enteredCompetitors.length > 0 && (
            <div className="space-y-2 pt-1">
              {form.enteredCompetitors.map((name) => (
                <div key={name} className="flex items-center gap-2">
                  <span className="w-40 shrink-0 truncate text-sm" title={name}>
                    {name}
                  </span>
                  <Input
                    aria-label={`Domain for ${name}`}
                    value={form.competitorDomains[name] ?? ""}
                    onChange={(e) => form.setCompetitorDomain(name, e.target.value)}
                    placeholder="northwind.example.com (optional)"
                    className="h-8 max-w-64 text-sm"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </fieldset>

      <div className="pt-1">
        <Button size="lg" disabled={!form.canContinue} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </section>
  );
}

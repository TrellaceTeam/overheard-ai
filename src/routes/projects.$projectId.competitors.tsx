/**
 * Owns the competitors screen: the rivals you track, the brands the extractor
 * found in answers, and the deep dive behind either one's name.
 *
 * A competitor can be added without a domain, as in project creation. A
 * citation is an answer linking one of the brand's domains, so a brand with
 * none on file scores 0% until one is given. A filled-in domain that does not
 * look like one is refused and named, not stored.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowDownRight, Plus, Search } from "lucide-react";
import { BadgeInput } from "@/components/BadgeInput";
import { DemoReadOnlyNote, DEMO_READONLY_REASON } from "@/components/DemoReadOnlyNote";
import { useIsDemo } from "@/components/useIsDemo";
import { DeleteBrandButton } from "@/components/DeleteBrandButton";
import { DiscoveredRow } from "@/components/DiscoveredRow";
import { useTrackBrand } from "@/components/useTrackBrand";
import { CompareTrend } from "@/components/CompareTrend";
import { CountingInfo } from "@/components/CountingInfo";
import { MetricGrid } from "@/components/MetricGrid";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isPlausibleDomain, normalizeDomain } from "@/lib/brand-matching";
import { errorText } from "@/lib/error-text";
import { aggregate, aggregateBrand, type Agg, type MetricRow } from "@/lib/metrics";
import { rankByMention } from "@/lib/competitor-list";
import { trendLabels } from "@/lib/trend-labels";
import {
  createCompetitor,
  deleteBrand,
  listBrandsFull,
  recomputeCitations,
  setBrandRole,
  updateBrand,
} from "@/server/api/brands";
import { listProjectMetrics } from "@/server/api/metrics";

/** What the screen needs of a brand. Mirrors the server's BrandFullView. */
type BrandRow = {
  id: string;
  name: string;
  role: string;
  variants: string[];
  domains: string[];
};

/**
 * Split entered domains into the ones to refuse and the ones to store.
 *
 * Bad values are named, not silently dropped, and nothing is stored while any
 * is refused. Unchecked, a pasted sentence becomes six domains and a citation
 * rate that stays at zero.
 */
export function reviewDomains(entries: readonly string[]): { bad: string[]; cleaned: string[] } {
  const entered = entries.map((d) => d.trim()).filter(Boolean);
  const bad = entered.filter((d) => !isPlausibleDomain(d));
  return { bad, cleaned: bad.length > 0 ? [] : [...new Set(entered.map(normalizeDomain))] };
}

export const Route = createFileRoute("/projects/$projectId/competitors")({
  head: () => ({
    meta: [
      { title: "Competitors - Overheard AI" },
      {
        name: "description",
        content:
          "Track competitors discovered in AI answers and compare their mention, rank and citation rates with yours.",
      },
    ],
  }),
  component: Competitors,
});

function Competitors() {
  const { projectId } = Route.useParams();
  const isDemo = useIsDemo(projectId);
  const demoReason = isDemo ? DEMO_READONLY_REASON : null;
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [discoveredQuery, setDiscoveredQuery] = useState("");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  // The same promotion action the dashboard's table uses. See useTrackBrand.
  const { trackingId, track } = useTrackBrand(projectId);

  const {
    data: brands,
    isPending: brandsPending,
    isError: brandsError,
  } = useQuery({
    queryKey: ["brands-full", projectId],
    queryFn: () => listBrandsFull({ data: { projectId } }),
  });

  const { data: rawMetrics } = useQuery({
    queryKey: ["project-metrics", projectId],
    queryFn: () => listProjectMetrics({ data: { projectId } }),
  });

  const metrics: MetricRow[] = useMemo(() => rawMetrics ?? [], [rawMetrics]);
  const all: BrandRow[] = brands ?? [];
  const tracked = all.filter((b) => b.role === "competitor");
  const discovered = all.filter((b) => b.role === "discovered");
  const discoveredVisible = discovered.filter(
    (b) =>
      !discoveredQuery.trim() ||
      b.name.toLowerCase().includes(discoveredQuery.trim().toLowerCase()),
  );
  const profileBrand = all.find((b) => b.id === profileId) ?? null;

  /**
   * The visible discovered brands, most mentioned first, each with its mention
   * rate and raw times-mentioned in this screen's whole-history scope. The
   * ranking is the dashboard cap's ranking (lib/competitor-list), so the two
   * screens agree on who matters. A brand nothing has measured yet sorts last
   * with a dash rate and a count of zero.
   */
  const discoveredRows = useMemo(
    () =>
      rankByMention(
        discoveredVisible.map((brand) => ({
          brand,
          agg: aggregateBrand(metrics, brand.id),
        })),
      ).map(({ brand, agg }) => ({
        brand,
        mentionRate: agg.mention_rate,
        mentions: agg.mentions,
      })),
    [discoveredVisible, metrics],
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["brands-full", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["brands", projectId] });
  };

  function say(error: unknown, fallback: string) {
    toast.error(errorText(error, fallback));
  }

  async function saveVariants(id: string, variants: string[]) {
    try {
      await updateBrand({ data: { id, variants } });
      refresh();
    } catch (error) {
      say(error, "Could not save those name variants");
    }
  }

  /**
   * Domains, validated by reviewDomains and then re-scored against the runs
   * already collected. is_cited is decided when an answer is extracted, so
   * without the re-score a corrected domain would change no number anywhere.
   */
  async function saveDomains(id: string, next: string[]) {
    const { bad, cleaned } = reviewDomains(next);
    if (bad.length > 0) {
      toast.error(
        `${bad.join(", ")} ${bad.length === 1 ? "does" : "do"} not look like a domain. Use the form acme.example.com.`,
      );
      return;
    }
    try {
      await updateBrand({ data: { id, domains: cleaned } });
      refresh();
    } catch (error) {
      say(error, "Could not save those domains");
      return;
    }
    try {
      const result = await recomputeCitations({ data: { brandId: id } });
      if (result.changed > 0) {
        toast.success(
          `${result.changed} citation${result.changed === 1 ? "" : "s"} corrected across ${result.runs} run${result.runs === 1 ? "" : "s"}`,
        );
      }
      void queryClient.invalidateQueries({ queryKey: ["project-metrics", projectId] });
    } catch (error) {
      say(error, "Saved, but we could not update your past runs.");
    }
  }

  async function addCompetitor() {
    const trimmedDomain = domain.trim();
    // The domain is optional, as in project creation. A competitor without one
    // scores no citations until it has one. A filled-in domain that does not
    // look like one is refused, named.
    if (trimmedDomain !== "" && !isPlausibleDomain(trimmedDomain)) {
      toast.error(
        "That does not look like a domain. Use the form acme.example.com, or leave it empty",
      );
      return;
    }
    setBusy(true);
    const trimmedName = name.trim();
    try {
      // The server owns the name comparison and reports which case the add
      // was. A duplicate gets a toast instead of being silently de-duplicated.
      const result = await createCompetitor({
        data: { projectId, name: trimmedName, domain: normalizeDomain(trimmedDomain) },
      });
      if (result.existingRole === "competitor") {
        toast.warning("You already track this competitor");
      } else if (result.existingRole === "discovered") {
        // The stored name, not the typed one, so a lower-cased entry still
        // names the brand as the card does.
        toast.success(`${result.name} was already in your discovered list. It is tracked now`);
        const rescored = result.rescored;
        if (rescored && rescored.changed > 0) {
          // The same sentence the tracked card's domain save uses: a domain
          // arriving re-decides past citations, and that is worth one line.
          toast.success(
            `${rescored.changed} citation${rescored.changed === 1 ? "" : "s"} corrected across ${rescored.runs} run${rescored.runs === 1 ? "" : "s"}`,
          );
          // The citation rates on screen are derived; make them re-derive.
          void queryClient.invalidateQueries({ queryKey: ["project-metrics", projectId] });
        }
      }
      setName("");
      setDomain("");
      refresh();
    } catch (error) {
      say(error, "Could not add that competitor");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Demote back to discovered. The brand and its history stay; it just stops
   * appearing in tracked comparisons and deep dives.
   */
  async function untrack(brand: BrandRow) {
    try {
      await setBrandRole({ data: { id: brand.id, role: "discovered" } });
      toast.success(`${brand.name} moved back to discovered`);
      refresh();
    } catch (error) {
      say(error, "Could not untrack this competitor");
    }
  }

  async function remove(brand: BrandRow) {
    setDeleting(brand.id);
    try {
      await deleteBrand({ data: { brandId: brand.id } });
      if (profileId === brand.id) setProfileId(null);
      refresh();
    } catch (error) {
      say(error, "Could not delete that brand");
    } finally {
      setDeleting(null);
    }
  }

  function Summary({ brandId }: { brandId: string }) {
    return (
      <MetricGrid
        tourId={null}
        variant="plain"
        agg={aggregateBrand(metrics, brandId)}
        subject="competitor"
      />
    );
  }

  return (
    <div className="stack-section">
      {isDemo && <DemoReadOnlyNote />}
      <div className="panel flex flex-wrap items-end gap-3 p-5">
        <fieldset
          disabled={isDemo}
          className="flex flex-1 flex-wrap items-end gap-3 disabled:opacity-60"
        >
          <div className="flex-1 space-y-2">
            <Label htmlFor="brand-name">Add a competitor</Label>
            <Input
              id="brand-name"
              value={name}
              placeholder="Northwind Metrics"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex-1 space-y-2">
            <Label htmlFor="brand-domain">Primary domain (optional)</Label>
            <Input
              id="brand-domain"
              value={domain}
              placeholder="northwind.example.com"
              onChange={(e) => setDomain(e.target.value)}
            />
          </div>
          <Button disabled={busy || !name.trim()} onClick={() => void addCompetitor()}>
            <Plus className="size-4" /> Add
          </Button>
        </fieldset>
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="type-section">Tracked competitors</h3>
          <div className="flex items-baseline gap-3">
            <p className="type-meta">{tracked.length} tracked</p>
            <CountingInfo />
          </div>
        </div>
        {tracked.length === 0 && (
          <p className="panel type-meta max-w-prose p-5">
            Nothing tracked yet. Track a discovered competitor below to compare it with your brand
            on the dashboard.
          </p>
        )}
        {tracked.map((brand) => (
          <div key={brand.id} className="panel space-y-5 p-5">
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setProfileId(brand.id)}
                className="type-section rounded py-0.5 underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {brand.name}
              </button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void untrack(brand)}
                  disabled={isDemo}
                  title={demoReason ?? undefined}
                >
                  <ArrowDownRight className="size-4" /> Untrack
                </Button>
                <DeleteBrandButton
                  brandName={brand.name}
                  tracked
                  onDelete={() => void remove(brand)}
                  onUntrack={() => void untrack(brand)}
                  deleting={deleting === brand.id}
                  locked={demoReason}
                />
              </div>
            </div>
            <Summary brandId={brand.id} />
            <fieldset
              disabled={isDemo}
              className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2 disabled:opacity-60"
            >
              <div className="space-y-1.5">
                <Label className="text-xs">Name variants</Label>
                <BadgeInput
                  value={brand.variants}
                  onChange={(variants) => void saveVariants(brand.id, variants)}
                  placeholder="Add a name variant"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Domains</Label>
                <BadgeInput
                  value={brand.domains}
                  onChange={(domains) => void saveDomains(brand.id, domains)}
                  placeholder="Add a domain"
                />
              </div>
            </fieldset>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-3">
            <h3 className="type-section">Discovered in answers</h3>
            <p className="type-meta">{discovered.length} discovered</p>
          </div>
          {discovered.length > 3 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={discoveredQuery}
                aria-label="Search discovered"
                onChange={(e) => setDiscoveredQuery(e.target.value)}
                placeholder="Search discovered"
                className="h-8 w-52 pl-8 text-xs"
              />
            </div>
          )}
        </div>
        {discovered.length === 0 &&
          (brandsPending ? (
            <p className="panel num type-meta p-5">Looking for brands in your answers…</p>
          ) : brandsError ? (
            <p className="panel type-meta p-5">
              We could not load discovered brands just now. Reload to try again.
            </p>
          ) : (
            <p className="panel type-meta max-w-prose p-5">
              {tracked.length > 0
                ? "Every brand found so far is tracked. New brands the assistants name will appear here."
                : "No discovered competitors yet. Any brand an assistant names in an answer appears here, whether or not you think of it as a competitor."}
            </p>
          ))}
        {discovered.length > 0 && discoveredVisible.length === 0 && (
          <p className="panel type-meta p-5">No discovered brands match that search.</p>
        )}
        {discoveredRows.map(({ brand, mentionRate, mentions }) => (
          <DiscoveredRow
            key={brand.id}
            name={brand.name}
            mentionRate={mentionRate}
            mentions={mentions}
            busy={trackingId === brand.id}
            locked={demoReason}
            deleting={deleting === brand.id}
            onTrack={() => void track(brand)}
            onDelete={() => void remove(brand)}
          />
        ))}
      </section>

      {profileBrand && (
        <CompetitorProfile
          brand={profileBrand}
          rows={metrics.filter((row) => row.brand_id === profileBrand.id)}
          allRows={metrics}
          onClose={() => setProfileId(null)}
        />
      )}
    </div>
  );
}

/**
 * One brand's mention rate run over run, for the deep dive.
 *
 * The denominator is every row in the run, not the brand's own. finalize-run
 * writes a run_metrics row only for a (model, prompt) scope where the brand was
 * observed, so the brand's own rows leave out every scope that never named it.
 * Using them as the denominator inflates the rate and disagrees with the card
 * above it in the same dialog. See the note on `aggregate` in lib/metrics.ts.
 */
export function competitorTrend(
  rows: MetricRow[],
  allRows: MetricRow[],
): Array<{ date: string; mention: number }> {
  const byRun = new Map<string, [MetricRow, ...MetricRow[]]>();
  for (const row of rows) {
    const list = byRun.get(row.run_id);
    if (list) list.push(row);
    else byRun.set(row.run_id, [row]);
  }
  const ordered = [...byRun.entries()].sort((a, b) =>
    a[1][0].created_at.localeCompare(b[1][0].created_at),
  );
  const labels = trendLabels(ordered.map(([, rs]) => rs[0].created_at));
  return ordered.map(([runId, rs], index) => ({
    date: labels[index] ?? "",
    mention: Math.round(
      (aggregate(
        rs,
        allRows.filter((row) => row.run_id === runId),
      ).mention_rate ?? 0) * 100,
    ),
  }));
}

/**
 * The deep dive behind a competitor's name: the same headline cards as the
 * dashboard, then that brand's mention rate run over run.
 *
 * No perception here: it is a project-level question about your own brand, not
 * about theirs.
 */
function CompetitorProfile({
  brand,
  rows,
  allRows,
  onClose,
}: {
  brand: BrandRow;
  rows: MetricRow[];
  allRows: MetricRow[];
  onClose: () => void;
}) {
  const agg: Agg = useMemo(() => aggregate(rows, allRows), [rows, allRows]);
  const trend = useMemo(() => competitorTrend(rows, allRows), [rows, allRows]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{brand.name}</DialogTitle>
          <DialogDescription>
            {[...brand.domains, ...brand.variants].join(" / ") || "No domains or variants yet"}
          </DialogDescription>
        </DialogHeader>
        <MetricGrid tourId={null} agg={agg} subject="competitor" variant="plain" />
        <div className="mt-4">
          <p className="mb-2 type-label">Mention rate over time</p>
          <CompareTrend
            data={trend}
            series={[{ key: "mention", label: "Mention rate", color: "var(--primary)" }]}
            empty="Two runs that mention this brand are needed before a trend appears."
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

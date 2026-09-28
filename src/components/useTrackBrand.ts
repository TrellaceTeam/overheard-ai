import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorText } from "@/lib/error-text";
import { setBrandRole } from "@/server/api/brands";

/**
 * Promotes a discovered rival to a tracked competitor. The dashboard's table
 * and the Competitors tab's rows make the same role change, say the same
 * sentence when it lands, and refresh the same two brand caches: the table and
 * comparison picker read one, the Competitors tab reads the other.
 */
export function useTrackBrand(projectId: string) {
  const queryClient = useQueryClient();
  /** The brand whose role change is in flight, if any. */
  const [trackingId, setTrackingId] = useState<string | null>(null);

  async function track(brand: { id: string; name: string }) {
    setTrackingId(brand.id);
    try {
      await setBrandRole({ data: { id: brand.id, role: "competitor" } });
      toast.success(`${brand.name} is now tracked`);
      void queryClient.invalidateQueries({ queryKey: ["brands", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["brands-full", projectId] });
    } catch (error) {
      toast.error(errorText(error, "Could not track this competitor"));
    } finally {
      setTrackingId(null);
    }
  }

  return { trackingId, track };
}

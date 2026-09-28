/**
 * The brand server functions: the target brand, tracked competitors, and the
 * brands the worker found in an answer.
 *
 * Saving domains takes two calls. updateBrand writes them, then
 * recomputeCitations re-decides past citations and returns what changed, which
 * the screen reports.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const projectId = z.object({ projectId: z.string().min(1) });
const brandId = z.object({ brandId: z.string().min(1) });

const createCompetitorInput = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(200),
  domain: z.string().max(300).default(""),
});

const updateBrandInput = z.object({
  id: z.string().min(1),
  name: z.string().max(200).optional(),
  variants: z.array(z.string().max(200)).max(50).optional(),
  domains: z.array(z.string().max(300)).max(50).optional(),
  suggestedDomains: z.array(z.string().max(300)).max(50).optional(),
});

const setBrandRoleInput = z.object({
  id: z.string().min(1),
  role: z.enum(["competitor", "discovered"]),
});

export const listBrands = createServerFn({ method: "GET" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { listBrands: op } = await import("./ops/brands");
    return op(getDb(), data.projectId);
  });

export const listBrandsFull = createServerFn({ method: "GET" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { listBrandsFull: op } = await import("./ops/brands");
    return op(getDb(), data.projectId);
  });

export const getTargetBrand = createServerFn({ method: "GET" })
  .validator((data: unknown) => projectId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { getTargetBrand: op } = await import("./ops/brands");
    return op(getDb(), data.projectId);
  });

/** Add a competitor. The domain is optional, and without one it scores no citations. */
export const createCompetitor = createServerFn({ method: "POST" })
  .validator((data: unknown) => createCompetitorInput.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { createCompetitor: op } = await import("./ops/brands");
    return op(getDb(), data);
  });

export const updateBrand = createServerFn({ method: "POST" })
  .validator((data: unknown) => updateBrandInput.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { updateBrand: op } = await import("./ops/brands");
    return op(getDb(), data);
  });

/** Track a discovered brand, or stop tracking a competitor. */
export const setBrandRole = createServerFn({ method: "POST" })
  .validator((data: unknown) => setBrandRoleInput.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { setBrandRole: op } = await import("./ops/brands");
    return op(getDb(), data);
  });

export const deleteBrand = createServerFn({ method: "POST" })
  .validator((data: unknown) => brandId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { deleteBrand: op } = await import("./ops/brands");
    return op(getDb(), data.brandId);
  });

/** Re-decide a brand's past citations after its domains change. Calls no provider. */
export const recomputeCitations = createServerFn({ method: "POST" })
  .validator((data: unknown) => brandId.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { recomputeCitations: op } = await import("./ops/brands");
    return op(getDb(), data.brandId);
  });

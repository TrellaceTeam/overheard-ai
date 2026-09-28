/**
 * The starter prompt generation server function: the setup screen's one-shot
 * call that rewrites the five starter prompts to fit the brand, on the user's
 * own key. The key is read inside the worker layer and never passes through
 * here.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { DESCRIPTION_MAX_CHARS } from "@/lib/onboarding";

const generateInput = z.object({
  brandName: z.string().min(1).max(200),
  category: z.string().max(200),
  description: z.string().max(DESCRIPTION_MAX_CHARS),
  variants: z.array(z.string().max(200)).max(50),
  competitors: z.array(z.string().max(200)).max(50),
});

export const generateStarterPrompts = createServerFn({ method: "POST" })
  .validator((data: unknown) => generateInput.parse(data))
  .handler(async ({ data }) => {
    const { getDb } = await import("../db/client");
    const { generateStarterPrompts: op } = await import("./ops/starter-prompts");
    const { configuredProviders } = await import("../worker/keys");
    return op(getDb(), data, { providersWithKeys: configuredProviders() });
  });

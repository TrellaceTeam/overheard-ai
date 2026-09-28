/**
 * The unfinished project setup, kept in the browser so a reload does not throw
 * away what was typed. A reload is what a user does after adding a key, and it
 * is how a dev server restart looks from the browser.
 *
 * Browser storage only, never the database: a draft is not a project, and
 * nothing in it leaves the machine. It sits under the overheard: prefix
 * (ADR 0003) and is checked field by field on the way back in, so a draft from
 * another build or a hand edit is dropped instead of breaking the screen.
 */
import type { PromptOrigin, StarterPrompt } from "@/lib/onboarding";

export const SETUP_DRAFT_KEY = "overheard:setup-draft";

/** What the setup form owns, and what a reload would lose. */
export interface WizardDraftFields {
  brandName: string;
  category: string;
  description: string;
  variants: string[];
  domains: string[];
  competitors: string[];
  competitorDomains: Record<string, string>;
  prompts: StarterPrompt[];
  promptOrigin: PromptOrigin | null;
  perceptionPrompt: string;
  perceptionDirty: boolean;
}

export interface SetupDraft extends WizardDraftFields {
  version: 1;
  savedAt: string;
  step: 0 | 1;
  /** Null while the default selection still follows the key check. */
  chosenModelIds: string[] | null;
}

/** The Storage methods used here, so a test can pass a fake. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** window.localStorage, or null during a server render or with storage turned off. */
export function browserStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

function isPrompt(value: unknown): value is StarterPrompt {
  return (
    isObject(value) &&
    isString(value["text"]) &&
    (value["tag"] === null || isString(value["tag"])) &&
    Number.isInteger(value["iterations"]) &&
    (value["iterations"] as number) >= 1 &&
    (value["iterations"] as number) <= 100
  );
}

function isOrigin(value: unknown): value is PromptOrigin {
  if (!isObject(value)) return false;
  const inputs = value["inputs"];
  return (
    (value["source"] === "template" ||
      value["source"] === "generated" ||
      value["source"] === "prefill") &&
    isObject(inputs) &&
    isString(inputs["brand"]) &&
    isString(inputs["category"]) &&
    isString(inputs["description"]) &&
    Array.isArray(value["prompts"]) &&
    value["prompts"].every(isPrompt)
  );
}

function isDraft(value: unknown): value is SetupDraft {
  if (!isObject(value)) return false;
  const domains = value["competitorDomains"];
  return (
    value["version"] === 1 &&
    isString(value["savedAt"]) &&
    (value["step"] === 0 || value["step"] === 1) &&
    isString(value["brandName"]) &&
    isString(value["category"]) &&
    isString(value["description"]) &&
    isStringArray(value["variants"]) &&
    isStringArray(value["domains"]) &&
    isStringArray(value["competitors"]) &&
    isObject(domains) &&
    Object.values(domains).every(isString) &&
    Array.isArray(value["prompts"]) &&
    value["prompts"].every(isPrompt) &&
    (value["promptOrigin"] === null || isOrigin(value["promptOrigin"])) &&
    isString(value["perceptionPrompt"]) &&
    typeof value["perceptionDirty"] === "boolean" &&
    (value["chosenModelIds"] === null || isStringArray(value["chosenModelIds"]))
  );
}

export function readSetupDraft(storage: DraftStorage | null): SetupDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SETUP_DRAFT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSetupDraft(
  storage: DraftStorage | null,
  draft: Omit<SetupDraft, "version" | "savedAt">,
  now: Date = new Date(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      SETUP_DRAFT_KEY,
      JSON.stringify({ version: 1, savedAt: now.toISOString(), ...draft }),
    );
  } catch {
    // A full or disabled storage only loses the draft, which is a convenience.
  }
}

export function clearSetupDraft(storage: DraftStorage | null): void {
  try {
    storage?.removeItem(SETUP_DRAFT_KEY);
  } catch {
    // As above.
  }
}

/** Whether anything was typed. An untouched form is not worth restoring. */
export function draftHasContent(fields: WizardDraftFields): boolean {
  return (
    fields.brandName.trim() !== "" ||
    fields.category.trim() !== "" ||
    fields.description.trim() !== "" ||
    fields.variants.length > 0 ||
    fields.domains.length > 0 ||
    fields.competitors.length > 0
  );
}

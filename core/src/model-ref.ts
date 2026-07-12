import { RuntimeError } from "./errors.js";
import type { ModelRef } from "./types.js";

export function parseModelRef(input?: string | ModelRef): ModelRef | undefined {
  if (!input) return undefined;
  if (typeof input !== "string") return input;
  const idx = input.indexOf(":");
  if (idx < 1) throw new RuntimeError("MODEL_REF_INVALID", input);
  return { provider: input.slice(0, idx), model: input.slice(idx + 1) };
}

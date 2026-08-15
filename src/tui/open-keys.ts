export type OpenPhase = "idle" | "confirm" | "waiting" | "uploading" | "done" | "failed";

export type OpenKeyAction = "prompt-confirm" | "start-upload" | "cancel" | null;

/** One-key `o` never uploads until a later `y` on the confirm overlay. */
export function resolveOpenKey(openPhase: OpenPhase, input: string): OpenKeyAction {
  if (openPhase === "idle" && input === "o") return "prompt-confirm";
  if (openPhase === "confirm" && (input === "y" || input === "Y")) return "start-upload";
  if (openPhase === "confirm" && (input === "n" || input === "N")) return "cancel";
  if ((openPhase === "waiting" || openPhase === "uploading") && (input === "n" || input === "N")) return "cancel";
  return null;
}

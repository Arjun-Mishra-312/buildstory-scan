let installed = false;

export function suppressExperimentalSqliteWarning(): void {
  if (installed) return;
  installed = true;
  const previous = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
    if (message.includes("SQLite is an experimental feature")) return;
    return (previous as (...callArgs: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning;
}

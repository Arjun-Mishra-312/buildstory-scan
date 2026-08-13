import React from "react";
import { render } from "ink";
import { GenerateApp, type GenerateTuiProps } from "./app.js";

export async function launchGenerateTui(props: GenerateTuiProps): Promise<number> {
  const instance = render(React.createElement(GenerateApp, props), {
    exitOnCtrlC: true,
    patchConsole: false,
  });
  await instance.waitUntilExit();
  return 0;
}

export function shouldUseGenerateTui(options: { json?: boolean; noTui?: boolean; quiet?: boolean }): boolean {
  if (options.json || options.noTui || options.quiet) return false;
  if (process.env.NO_COLOR === "1") return Boolean(process.stdout.isTTY) && !options.json;
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

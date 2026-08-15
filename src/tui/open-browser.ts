import { spawn } from "node:child_process";

export function openBrowser(url: string): void {
  const options = { detached: true, stdio: "ignore" as const };
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], options).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], options).unref();
    return;
  }
  spawn("xdg-open", [url], options).unref();
}

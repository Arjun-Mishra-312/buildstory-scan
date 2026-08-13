import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../canonical-json.js";
import type { ProjectSnapshot } from "../contract.js";
import { renderHtmlReport, renderMarkdownReport } from "./report.js";

export type WrittenReportFiles = {
  directory: string;
  json: string;
  markdown: string;
  html: string;
};

export async function writeLocalReportFiles(
  snapshot: ProjectSnapshot,
  directory: string,
): Promise<WrittenReportFiles> {
  const resolved = path.resolve(directory);
  await mkdir(resolved, { recursive: true });
  const json = path.join(resolved, "report.json");
  const markdown = path.join(resolved, "report.md");
  const html = path.join(resolved, "report.html");
  await Promise.all([
    writeFile(json, canonicalJson(snapshot), { encoding: "utf8", mode: 0o600 }),
    writeFile(markdown, renderMarkdownReport(snapshot), "utf8"),
    writeFile(html, renderHtmlReport(snapshot), "utf8"),
  ]);
  return { directory: resolved, json, markdown, html };
}

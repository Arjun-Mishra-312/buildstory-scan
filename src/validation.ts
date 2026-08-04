import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ErrorObject, Options } from "ajv";
import type { Ajv2020 as Ajv2020Instance } from "ajv/dist/2020.js";
import type { ProjectSnapshot } from "./contract.js";
import { ScannerError } from "./errors.js";

const schemaPath = fileURLToPath(new URL("../../schema/project-snapshot.schema.json", import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
const require = createRequire(import.meta.url);
const ajvModule = require("ajv/dist/2020.js") as { default?: unknown };
const formatsModule = require("ajv-formats") as { default?: unknown };
const Ajv2020 = (ajvModule.default ?? ajvModule) as new (options?: Options) => Ajv2020Instance;
const addFormats = (formatsModule.default ?? formatsModule) as (instance: Ajv2020Instance) => unknown;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile<ProjectSnapshot>(schema);

export function validateProjectSnapshot(value: unknown): asserts value is ProjectSnapshot {
  if (validate(value)) return;
  const details = (validate.errors ?? [])
    .slice(0, 5)
    .map((error: ErrorObject) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
  throw new ScannerError("SNAPSHOT_SCHEMA_INVALID", `Generated payload failed schema validation: ${details}`);
}

export function getProjectSnapshotSchema(): object {
  return structuredClone(schema);
}

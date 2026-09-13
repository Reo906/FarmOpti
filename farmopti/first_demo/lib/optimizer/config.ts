import fs from "node:fs";
import { load as loadYaml } from "js-yaml";
import { CONFIG_PATH } from "./paths";

// The config schema is large (operations, crop parameters, beam search,
// solver, and LLM/retrieval settings). We keep it loosely typed and let
// each module read the specific keys it needs, mirroring how the Python
// pipeline just treated it as a plain dict.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ConfigDict = any;

export function loadConfig(path: string = CONFIG_PATH): ConfigDict {
  const text = fs.readFileSync(path, "utf-8");
  return loadYaml(text) as ConfigDict;
}

export const CONFIG: ConfigDict = loadConfig();
export const RULES: ConfigDict = CONFIG.operations;
export const CROP_PARAMETERS: ConfigDict = CONFIG.crop_parameters;
export const CANDIDATE_CONFIG: ConfigDict = CONFIG.candidate_generation;

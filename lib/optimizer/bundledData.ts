import fs from "node:fs";

// The CLI pipeline (`tsx lib/optimizer/pipeline.ts`) runs in real Node with
// real disk access, so every fs.readFileSync call below succeeds there and
// this module's fallback is never reached.
//
// The web chatbot instead runs inside the Cloudflare Workers (workerd)
// sandbox this app is deployed to (via vinext/wrangler). That sandbox has no
// access to the real project files at all -- only the bundled worker code
// itself -- so a runtime `fs` read of data/config.yaml or the generated
// decision evidence can never succeed there, however the path is spelled.
// To let the chatbot's read-only lookups work anyway, this bundles the raw
// text of everything under FarmOpti/data/ at build time via Vite's
// import.meta.glob, and serves that pre-bundled copy once a real fs read
// fails. Nothing here changes what any of that data means -- it only
// changes how its bytes get into memory when there is no real disk to read.
let bundled: Record<string, string> | null = null;

function loadBundled(): Record<string, string> {
  if (!bundled) {
    bundled = import.meta.glob(
      ["/data/**/*.yaml", "/data/**/*.json", "/data/**/*.jsonl", "/data/**/*.csv"],
      { eager: true, query: "?raw", import: "default" },
    ) as Record<string, string>;
  }
  return bundled;
}

function findBundled(absolutePath: string): string | undefined {
  const normalized = absolutePath.replace(/\\/g, "/");
  const files = loadBundled();
  const key = Object.keys(files).find((candidate) => normalized.endsWith(candidate.replace(/^\//, "")));
  return key === undefined ? undefined : files[key];
}

/** Reads a text file under FarmOpti/data/, falling back to the build-time bundle if real fs access is unavailable. */
export function readDataFile(absolutePath: string): string {
  try {
    return fs.readFileSync(absolutePath, "utf-8");
  } catch (fsError) {
    const text = findBundled(absolutePath);
    if (text !== undefined) return text;
    throw fsError;
  }
}

/** Mirrors fs.existsSync for a file under FarmOpti/data/, also checking the build-time bundle. */
export function dataFileExists(absolutePath: string): boolean {
  if (fs.existsSync(absolutePath)) return true;
  return findBundled(absolutePath) !== undefined;
}

/** Mirrors fs.readdirSync for a directory under FarmOpti/data/, also checking the build-time bundle. */
export function listDataDir(absoluteDirPath: string): string[] {
  try {
    return fs.readdirSync(absoluteDirPath);
  } catch (fsError) {
    const normalizedDir = absoluteDirPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const files = loadBundled();
    const names = Object.keys(files)
      .filter((key) => normalizedDir.endsWith(key.slice(0, key.lastIndexOf("/")).replace(/^\//, "")))
      .map((key) => key.slice(key.lastIndexOf("/") + 1));
    if (names.length > 0) return names;
    throw fsError;
  }
}

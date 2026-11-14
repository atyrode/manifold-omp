import family from "../package.json";
import runtime from "./runtime-artifacts.json";
import grammars from "./runtime-data/omp-grammar-assets-v1/grammars-v1.json";

export const SDK_HOST_ASSET = "omp-sdkHost.tar.gz";
export const GRAMMAR_ASSET = "omp-grammars-v1.tar.gz";
export const SOURCE_ASSETS = [GRAMMAR_ASSET, SDK_HOST_ASSET] as const;
export function sourceAssetUrl(filename: typeof SOURCE_ASSETS[number]): string {
  return `https://github.com/atyrode/manifold-omp/releases/download/v${family.version}/${filename}`;
}

// An explicit second archive, not implicit primary-archive extraction or extra aliases.
// The full publisher manifest and notices remain selected alongside every WASM file.
const companions = grammars.members.filter(member => member.path !== "manifest.json");
const manifest = grammars.members.find(member => member.path === "manifest.json")!;
const grammarGroup = {
  target: ["omp-grammars"],
  artifact: {
    url: sourceAssetUrl(GRAMMAR_ASSET), sha256: grammars.archive.sha256, format: "tar.gz" as const,
    entry: [manifest.path], entrySha256: manifest.sha256,
    maxBytes: grammars.archive.maxBytes, maxExpandedBytes: grammars.archive.maxExpandedBytes,
    maxMembers: grammars.archive.maxMembers,
    files: Object.fromEntries(companions.map((member, index) => [
      `file-${index}`, { entry: [member.path], sha256: member.sha256 },
    ])),
  },
  entryTarget: [manifest.path],
  fileTargets: Object.fromEntries(companions.map((member, index) => [`file-${index}`, [member.path]])),
};

export const ompRuntimeTools = {
  "linux-x64": { ...runtime.tools.omp["linux-x64"], fileGroups: [grammarGroup] },
  "linux-arm64": { ...runtime.tools.omp["linux-arm64"], fileGroups: [grammarGroup] },
};

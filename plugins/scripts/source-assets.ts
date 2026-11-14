import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { machineArtifacts, type MachineHalf } from "@manifold/protocol";
import { SOURCE_ASSETS, sourceAssetUrl } from "../runtime-assets.ts";
import family from "../../package.json";

/** Trusted verifier input only. Declarations retain their production HTTPS URL and
 * SHA; the owner's normal acquisition still checks authority, archives and members.
 * Nothing here writes an artifact cache or represents an HTTP response. */
export async function preparedSourceArtifacts(directory: string, machine: MachineHalf): Promise<ReadonlyMap<string, Uint8Array>> {
  const archives = new Map<string, Uint8Array>();
  const declarations = machineArtifacts(machine);
  for (const filename of SOURCE_ASSETS) {
    const url = sourceAssetUrl(filename);
    const specifications = declarations.filter(spec => spec.url === url);
    if (specifications.length === 0) throw new Error(`Missing owned source asset declaration: ${filename}`);
    const bytes = await readFile(join(directory, filename));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    for (const spec of specifications) {
      if (spec.bundleFile !== undefined || spec.sha256 !== sha256 || bytes.length !== spec.maxBytes)
        throw new Error(`Owned source asset differs from its shipped URL/SHA/bound: ${filename}`);
      archives.set(`${url}\0${spec.sha256}`, bytes);
    }
  }
  return archives;
}

/** Availability is a separate postpublication claim. Hashes and versioned URLs
 * are enforced; GitHub's release immutability setting is not changed or assumed. */
export async function verifyPublishedRelease(): Promise<void> {
  const response = await fetch(`https://api.github.com/repos/atyrode/manifold-omp/releases/tags/v${family.version}`, {
    headers: { accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Published family release is unavailable");
  const release = await response.json() as {
    tag_name?: unknown; draft?: unknown; assets?: { name?: unknown; browser_download_url?: unknown }[];
  };
  if (release.tag_name !== `v${family.version}` || release.draft !== false || !Array.isArray(release.assets))
    throw new Error("Published family release identity differs");
  const expected = ["atyrode.omp.manifold-plugin.json", "atyrode.omp.accounts.manifold-plugin.json",
    "atyrode.omp.gateway.manifold-plugin.json", ...SOURCE_ASSETS, "SHA256SUMS"].sort();
  if (release.assets.map(asset => asset.name).sort().join("\0") !== expected.join("\0"))
    throw new Error("Published family release has an incomplete or unexpected asset set");
  for (const filename of SOURCE_ASSETS) {
    if (release.assets.find(asset => asset.name === filename)?.browser_download_url !== sourceAssetUrl(filename))
      throw new Error("Published runtime asset URL differs from the shipped declaration");
  }
}

// Offline capability proof shared by packaged SDK and stock-CLI fixtures.
// The caller configures the native grammar directory; this module never installs grammars.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

export interface GrammarCase {
  language: string;
  extension: string;
  source: string;
  pattern: string;
}

// One nonempty syntactically valid construct for every published 18.20 WASM grammar.
// The published PHP registry selects php_only, whose opening tag is optional.
const languageSources: readonly Omit<GrammarCase, "pattern">[] = [
  { language: "astro", extension: "astro", source: "<div>proof</div>" },
  { language: "clojure", extension: "clj", source: "(def proof 1)" },
  { language: "cmake", extension: "cmake", source: "set(PROOF 1)" },
  { language: "csharp", extension: "cs", source: "class Proof {}" },
  { language: "dart", extension: "dart", source: "int proof() => 1;" },
  { language: "dockerfile", extension: "dockerfile", source: "FROM scratch\n" },
  { language: "elixir", extension: "ex", source: "defmodule Proof do\n  def value(), do: 1\nend" },
  { language: "emacs-lisp", extension: "el", source: "(setq proof 1)" },
  { language: "erlang", extension: "erl", source: "proof() -> ok." },
  { language: "fortran", extension: "f90", source: "program proof\n  implicit none\nend program proof\n" },
  { language: "graphql", extension: "graphql", source: "query Proof { proof }" },
  { language: "haskell", extension: "hs", source: "proof = 1\n" },
  { language: "hcl", extension: "hcl", source: "proof = 1\n" },
  { language: "ini", extension: "ini", source: "proof = 1\n" },
  { language: "julia", extension: "jl", source: "proof() = 1" },
  { language: "just", extension: "just", source: "proof:\n    echo proof\n" },
  { language: "kotlin", extension: "kt", source: "fun proof(): Int = 1" },
  { language: "lua", extension: "lua", source: "local proof = 1" },
  { language: "make", extension: "mk", source: "proof:\n\t@echo proof\n" },
  { language: "nix", extension: "nix", source: "{ proof = 1; }" },
  { language: "objc", extension: "m", source: "@interface Proof\n@end" },
  { language: "ocaml", extension: "ml", source: "let proof = 1" },
  { language: "odin", extension: "odin", source: "package proof\n" },
  { language: "php", extension: "php", source: "function proof() { return 1; }" },
  { language: "powershell", extension: "ps1", source: "function Proof { 1 }" },
  { language: "protobuf", extension: "proto", source: "message Proof { string value = 1; }" },
  { language: "r", extension: "r", source: "proof <- 1" },
  { language: "ruby", extension: "rb", source: "def proof\n  1\nend" },
  { language: "scala", extension: "scala", source: "object Proof { val value = 1 }" },
  { language: "solidity", extension: "sol", source: "contract Proof { uint256 value; }" },
  { language: "sql", extension: "sql", source: "SELECT 1;" },
  { language: "starlark", extension: "bzl", source: "proof = 1\n" },
  { language: "svelte", extension: "svelte", source: "<h1>proof</h1>" },
  { language: "swift", extension: "swift", source: "let proof = 1" },
  { language: "tlaplus", extension: "tla", source: "---- MODULE Proof ----\nproof == 1\n====\n" },
  { language: "verilog", extension: "v", source: "module proof;\nendmodule\n" },
  { language: "vue", extension: "vue", source: "<template><div>proof</div></template>" },
  { language: "xml", extension: "xml", source: "<proof>value</proof>" },
  { language: "zig", extension: "zig", source: "const proof: u32 = 1;" },
];

export const grammarCases: readonly GrammarCase[] = languageSources.map(item => ({ ...item, pattern: item.source }));

// Each body exceeds the stock read minimum (100 lines) and unfold ceiling, so
// both configured SDK reads and unmodified CLI read summaries can retain its declaration.
export const summaryCases = [
  {
    language: "nix", extension: "nix", retained: "proof:", omitted: "proof_hidden",
    source: `proof: {\n${Array.from({ length: 110 }, (_, index) =>
      `  ${index === 50 ? "proof_hidden" : `field${index}`} = ${index};`).join("\n")}\n}\n`,
  },
  {
    language: "sql", extension: "sql", retained: "CREATE TABLE proof", omitted: "proof_hidden",
    source: `CREATE TABLE proof (\n${Array.from({ length: 110 }, (_, index) =>
      `  ${index === 50 ? "proof_hidden" : `field${index}`} INTEGER`).join(",\n")}\n);\n`,
  },
  {
    language: "vue", extension: "vue", retained: "<template>", omitted: "proof_hidden",
    source: `<template>\n  <section>\n${Array.from({ length: 110 }, (_, index) =>
      `    <p>${index === 50 ? "proof_hidden" : `field${index}`}</p>`).join("\n")}\n  </section>\n</template>\n`,
  },
] as const;

function requireCapability(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`grammar_capability_missing:${detail}`);
}


export async function exerciseGrammarOperations(root: string) {
  // Data-only consumers (notably the standalone CLI proof) must not load the SDK or addon.
  const [{ Settings }, { renderSummary, trySummarize }, { astMatch, parseCodeStatus, summarizeCodeAsync, wasmGrammarFor },
    { highlightCode }, { loadTheme }] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/config/settings"),
    import("@oh-my-pi/pi-coding-agent/tools/read-summary"),
    import("@oh-my-pi/pi-natives"),
    import("@oh-my-pi/pi-tui/theme"),
    import("@oh-my-pi/pi-tui/theme/loader"),
  ]);
  function installedGrammar(language: string) {
    const grammar = wasmGrammarFor({ lang: language });
    // Fail before the SDK's ensureGrammar consumer can attempt its stock downloader.
    requireCapability(grammar && grammar.installed, `${language}:preinstalled_wasm`);
    return grammar;
  }
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "grammar-operations-"));
  requireCapability(grammarCases.length === 39 && new Set(grammarCases.map(item => item.language)).size === 39,
    "complete_unique_grammar_cases");
  const grammars = [];
  for (const item of grammarCases) {
    const grammar = installedGrammar(item.language);
    const path = join(directory, `proof.${item.extension}`);
    await writeFile(path, item.source);
    const parsed = parseCodeStatus({ code: item.source, lang: item.language, path });
    requireCapability(parsed.parsed && parsed.language, `${item.language}:valid_source_parse`);
    const result = await astMatch({
      source: item.source, lang: item.language, patterns: [item.pattern], limit: 64,
    });
    requireCapability(!result.parseErrors?.length && !result.limitReached && result.totalMatches > 0,
      `${item.language}:ast_match:${JSON.stringify(result.parseErrors ?? [])}`);
    const matched = result.matches.find(match => match.text.trim() === item.source.trim());
    requireCapability(matched && matched.byteEnd > matched.byteStart, `${item.language}:positive_exact_ast_match`);
    const matchedBytes = Buffer.from(item.source).subarray(matched.byteStart, matched.byteEnd).toString("utf8");
    requireCapability(matchedBytes === matched.text, `${item.language}:ast_source_range`);
    grammars.push({
      language: item.language, parsedLanguage: parsed.language, file: grammar.file, sha256: grammar.sha256,
      totalMatches: result.totalMatches, matchedText: matched.text, byteStart: matched.byteStart, byteEnd: matched.byteEnd,
    });
  }
  requireCapability(new Set(grammars.map(item => item.file)).size === 39, "distinct_wasm_grammars_exercised");

  const settings = Settings.isolated({
    "read.summarize.minTotalLines": 100, "read.summarize.minBodyLines": 4,
    "read.summarize.minCommentLines": 6, "read.summarize.unfoldUntil": 0, "read.summarize.unfoldLimit": 0,
  });
  const session: ToolSession = {
    cwd: directory, hasUI: false, settings, getSessionFile: () => null, getSessionSpawns: () => null,
  };
  const highlightTheme = await loadTheme("dark"); // Embedded publisher theme; no custom theme discovery.
  const consumers = [];
  for (const item of summaryCases) {
    installedGrammar(item.language);
    const path = join(directory, `read.${item.extension}`);
    await writeFile(path, item.source);
    const nativeSummary = await summarizeCodeAsync({
      code: item.source, path, minBodyLines: 4, minCommentLines: 6, unfoldUntilLines: 0, unfoldLimitLines: 0,
    });
    requireCapability(nativeSummary.parsed && nativeSummary.elided, `${item.language}:native_read_summary`);
    // Exercise the SDK's real file-reading, language-inference, grammar and summary-cache path.
    const summary = await trySummarize(session, path, Buffer.byteLength(item.source));
    requireCapability(summary && summary.parsed && summary.elided, `${item.language}:sdk_read_summary`);
    requireCapability(JSON.stringify(summary) === JSON.stringify(nativeSummary), `${item.language}:sdk_summary_matches_native`);
    const rendered = renderSummary(session, summary);
    const renderedText = JSON.stringify(rendered);
    requireCapability(!renderedText.includes(item.omitted) && renderedText.includes(item.retained),
      `${item.language}:summary_retains_declaration_and_elides_body`);
    requireCapability(summary.segments.some(segment => segment.kind === "kept" && segment.text?.trim()) &&
      summary.segments.some(segment => segment.kind === "elided" && segment.endLine >= segment.startLine),
    `${item.language}:summary_keeps_boundaries`);
    const highlighted = highlightCode(item.source, item.language, highlightTheme).join("\n");
    const plain = highlighted.replace(/\x1b\[[0-9;]*m/g, "");
    requireCapability(plain === item.source && highlighted !== plain && /\x1b\[[0-9;]+m/.test(highlighted),
      `${item.language}:sdk_highlight_not_passthrough`);
    consumers.push({
      language: item.language, parsedLanguage: summary.language ?? null, totalLines: summary.totalLines,
      elidedRanges: summary.segments.filter(segment => segment.kind === "elided").map(segment => ({
        startLine: segment.startLine, endLine: segment.endLine,
      })),
      highlighted: true, highlightPreservesSource: true,
      highlightAnsiSequences: highlighted.match(/\x1b\[[0-9;]*m/g)?.length ?? 0,
    });
  }
  return { schemaVersion: 1 as const, grammars, consumers };
}

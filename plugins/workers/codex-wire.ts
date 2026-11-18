// The SDK's reviewed wire version disables its mutable disk cache and background npm lookup.
// Keep privileged worker entrypoints free of provider SDK imports until after environment isolation.
export const CODEX_WIRE_VERSION = "0.169.0";

import { z } from "zod";
import { ProbeError } from "../api/probe.ts";
import { OmpDataError } from "../api/errors.ts";
import { OmpRefusal } from "./machine-server.ts";

/**
 * An unknown failure answers `omp_operation_unavailable`, which says only that the door did
 * not work. That is the right answer for a caller and a useless one for an operator: three
 * separate blockers in the OMP family reached a reader as this single string, and each cost a
 * database read to identify. The cause is reported to this plugin's own log instead.
 */
export function refusal(error: unknown) {
  if (error instanceof OmpRefusal || error instanceof OmpDataError) return { refused: error.message };
  if (error instanceof ProbeError) return { refused: `omp_probe_${error.code}` };
  if (error instanceof z.ZodError) return { refused: "omp_invalid_request" };
  console.warn(
    `atyrode.omp: operation_unavailable: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
  );
  return { refused: "omp_operation_unavailable" };
}

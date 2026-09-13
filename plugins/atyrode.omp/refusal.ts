import { z } from "zod";
import { ProbeError } from "../api/probe.ts";
import { OmpDataError } from "../api/errors.ts";
import { OmpRefusal } from "./machine-server.ts";

export function refusal(error: unknown) {
  if (error instanceof OmpRefusal || error instanceof OmpDataError) return { refused: error.message };
  if (error instanceof ProbeError) return { refused: `omp_probe_${error.code}` };
  if (error instanceof z.ZodError) return { refused: "omp_invalid_request" };
  return { refused: "omp_operation_unavailable" };
}

export class OmpDataError extends Error {
  constructor(readonly code: "invalid_accounts" | "invalid_usage" | "invalid_session") { super(`omp_${code}`); }
}

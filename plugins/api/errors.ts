export class OmpDataError extends Error {
  constructor(readonly code: "invalid_accounts" | "invalid_usage") { super(`omp_${code}`); }
}

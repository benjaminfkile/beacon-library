// The logger the caller hands the beacon library. Every log site takes a
// structured fields object and a message string, matching pino's call shape
// so a pino instance is assignable without a wrapper. `info` and `warn` cover
// the loops; `error` is used by the facade's leader gate when a caller
// callback throws.

export interface BeaconLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

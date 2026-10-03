/** A step could not run: throttle, timeout, 5xx, auth. Providers and assertion plugins reject with this only. */
export class InfraError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'InfraError';
    this.retryable = opts.retryable ?? true;
  }
}

/** The suite or setup is wrong (unknown provider, missing assertion plugin, empty suite). EvalRunner.run rejects with this only. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function isInfraError(e: unknown): e is InfraError {
  return e instanceof Error && e.name === 'InfraError';
}

export function isConfigError(e: unknown): e is ConfigError {
  return e instanceof Error && e.name === 'ConfigError';
}

const NON_RETRYABLE = /api key|credential|unauthori[sz]ed|forbidden|access ?denied|not found|invalid model|401|403|404/i;

/** Wrap any thrown value as InfraError, guessing retryability from the message. */
export function toInfraError(e: unknown): InfraError {
  if (isInfraError(e)) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new InfraError(msg, { retryable: !NON_RETRYABLE.test(msg), cause: e });
}

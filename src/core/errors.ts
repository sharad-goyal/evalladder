/** Infra failure: throttle, timeout, 5xx, auth, bad config. The only reason a provider or grader rejects. */
export class InfraError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'InfraError';
    this.retryable = opts.retryable ?? true;
  }
}

export function isInfraError(e: unknown): e is InfraError {
  return e instanceof Error && e.name === 'InfraError';
}

const NON_RETRYABLE = /api key|credential|unauthori[sz]ed|forbidden|access ?denied|not found|invalid model|401|403|404/i;

/** Wrap any thrown value as InfraError, guessing retryability from the message. */
export function toInfraError(e: unknown): InfraError {
  if (isInfraError(e)) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new InfraError(msg, { retryable: !NON_RETRYABLE.test(msg), cause: e });
}

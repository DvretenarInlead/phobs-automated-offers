export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode: number, code: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class SignatureError extends AppError {
  constructor(message = 'Invalid signature') {
    super(message, 401, 'signature_invalid');
  }
}

export class AuthError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'unauthorized');
  }
}

export class ValidationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 400, 'validation_failed', cause);
  }
}

export class TenantNotFoundError extends AppError {
  constructor(hubId: bigint | number) {
    super(`Tenant ${String(hubId)} not found`, 404, 'tenant_not_found');
  }
}

export class TenantSuspendedError extends AppError {
  constructor(hubId: bigint | number) {
    super(`Tenant ${String(hubId)} suspended`, 423, 'tenant_suspended');
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterMs: number) {
    super('Rate limited', 429, 'rate_limited');
    this.retryAfterMs = retryAfterMs;
  }
  public retryAfterMs: number;
}

export class ExternalServiceError extends AppError {
  constructor(
    public readonly target: 'hubspot' | 'phobs',
    message: string,
    public readonly upstreamStatus?: number,
    cause?: unknown,
  ) {
    super(message, 502, `${target}_error`, cause);
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof AppError) {
    if (err instanceof ExternalServiceError) {
      const s = err.upstreamStatus ?? 0;
      return s === 0 || s === 408 || s === 429 || s >= 500;
    }
    if (err instanceof RateLimitedError) return true;
    return false;
  }
  return true; // unknown errors → retry conservatively
}

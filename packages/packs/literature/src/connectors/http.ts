import type { SourceError, SourceErrorType } from "../types.js";

export class SourceRequestError extends Error {
  constructor(
    readonly errorType: SourceErrorType,
    readonly retryable: boolean,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "SourceRequestError";
  }
}

type RequestRetryOptions = { attempts?: number; timeoutMs?: number; retryBaseDelayMs?: number };

export async function getJson<T>(url: string, headers?: Record<string, string>, options?: RequestRetryOptions): Promise<T> {
  const res = await requestWithRetry(url, headers, options);
  return res.json() as Promise<T>;
}

export async function getText(url: string, headers?: Record<string, string>, options?: RequestRetryOptions): Promise<string> {
  const res = await requestWithRetry(url, headers, options);
  return res.text();
}

async function requestWithRetry(url: string, headers?: Record<string, string>, options: RequestRetryOptions = {}): Promise<Response> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 20000;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { headers: { "user-agent": "jiuwen-sci/0.1", ...(headers ?? {}) }, signal: controller.signal });
      clearTimeout(timeout);
      timeout = undefined;
      if (res.ok) return res;
      const classified = classifyHttpError(res.status, `${res.status} ${res.statusText}: ${url}`);
      if (!classified.retryable || attempt === attempts) throw classified;
      await sleep(retryBaseDelayMs * attempt * attempt);
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      lastError = error;
      const requestError = toSourceRequestError(error, url);
      if (!requestError.retryable || attempt === attempts) throw requestError;
      await sleep(retryBaseDelayMs * attempt * attempt);
    }
  }
  throw toSourceRequestError(lastError, url);
}

function classifyHttpError(status: number, message: string): SourceRequestError {
  if (status === 429) return new SourceRequestError("rate_limited", true, message, status);
  if (status === 404) return new SourceRequestError("not_found", false, message, status);
  if (status >= 500) return new SourceRequestError("server_error", true, message, status);
  if (status >= 400) return new SourceRequestError("bad_request", false, message, status);
  return new SourceRequestError("unknown", false, message, status);
}

function toSourceRequestError(error: unknown, url: string): SourceRequestError {
  if (error instanceof SourceRequestError) return error;
  if (error instanceof Error && error.name === "AbortError") return new SourceRequestError("timeout", true, `Request timed out: ${url}`);
  if (error instanceof Error) return new SourceRequestError("network", true, error.message);
  return new SourceRequestError("unknown", true, String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sourceError(db: string, operation: SourceError["operation"], error: unknown): SourceError {
  const requestError = toSourceRequestError(error, `${db}:${operation}`);
  return {
    ok: false,
    db,
    operation,
    errorType: requestError.errorType,
    retryable: requestError.retryable,
    message: requestError.message,
    guidance: sourceErrorGuidance(requestError.errorType, operation),
    status: requestError.status
  };
}

function sourceErrorGuidance(errorType: SourceErrorType, operation: SourceError["operation"]): string {
  if (errorType === "rate_limited") return "Back off and retry later; reduce limit or prefer a connector with an API key.";
  if (errorType === "timeout" || errorType === "server_error" || errorType === "network") return `Retry ${operation} or continue with other sources while preserving this source error.`;
  if (errorType === "bad_request") return "Revise the query syntax or identifier before retrying.";
  if (errorType === "not_found") return "Try DOI, source-native identifier, or another metadata source.";
  if (errorType === "unsupported") return "Use another connector that supports this operation.";
  return "Record the source error and continue with corroborating databases.";
}

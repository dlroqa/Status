/**
 * The only place the app performs network I/O. Lives in the main process so the renderer
 * stays fully offline and no credential is ever handed to a browser context.
 */

export type HttpFailureKind = 'unauthorized' | 'forbidden' | 'rate-limited' | 'http' | 'network' | 'timeout' | 'parse';

export type HttpResult =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly kind: HttpFailureKind; readonly status?: number; readonly reason: string };

const DEFAULT_TIMEOUT_MS = 15_000;

export interface GetJsonOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * GETs JSON, mapping transport and status failures onto a closed set of kinds so callers
 * can turn them into precise, actionable user-facing reasons instead of a generic error.
 */
export async function getJson(url: string, options: GetJsonOptions = {}): Promise<HttpResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const abortOuter = (): void => controller.abort();
  options.signal?.addEventListener('abort', abortOuter, { once: true });

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...options.headers },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      return { ok: false, kind: kindForStatus(response.status), status: response.status, reason: `HTTP ${response.status} ${response.statusText}`.trim() };
    }

    const text = await response.text();
    try {
      return { ok: true, status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, kind: 'parse', status: response.status, reason: 'response was not valid JSON' };
    }
  } catch (error) {
    if (isAbort(error)) {
      // An outer abort means the app is shutting down or refreshing; a timer abort is a real timeout.
      return options.signal?.aborted === true
        ? { ok: false, kind: 'network', reason: 'request cancelled' }
        : { ok: false, kind: 'timeout', reason: `no response within ${Math.round(timeoutMs / 1000)}s` };
    }
    return { ok: false, kind: 'network', reason: networkReason(error) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortOuter);
  }
}

function kindForStatus(status: number): HttpFailureKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate-limited';
  return 'http';
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function networkReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // fetch wraps the useful detail (DNS failure, refused connection) in `cause`.
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  return error.message;
}

/**
 * Logging with mandatory secret redaction.
 *
 * Adapters handle live subscription tokens. A token in a log file is a leaked credential,
 * so every message goes through `redact` before it is written — there is no unredacted
 * path out of this module.
 */

const SECRET_PATTERNS: readonly RegExp[] = [
  // OAuth bearer values in headers or stringified requests.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi,
  // JSON fields that carry credentials, e.g. "accessToken": "..." or "refresh_token":"..."
  /("(?:access|refresh|id)[_-]?token"\s*:\s*")[^"]*(")/gi,
  /("(?:api[_-]?key|secret|password)"\s*:\s*")[^"]*(")/gi,
  // JWTs anywhere in free text.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Anthropic and OpenAI key/token prefixes.
  /\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g,
];

export function redact(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (...args: unknown[]): string => {
      // replace() passes (match, ...groups, offset, whole). Patterns with no capture
      // groups therefore hand us the offset and the entire input string in those slots,
      // so the arguments must be type-checked rather than positionally trusted — treating
      // them as groups would splice the unredacted input straight back into the log.
      const [, first, second] = args;
      return typeof first === 'string' && typeof second === 'string'
        ? `${first}[redacted]${second}`
        : '[redacted]';
    });
  }
  return output;
}

function render(parts: readonly unknown[]): string {
  return parts
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part instanceof Error) return `${part.name}: ${part.message}`;
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .join(' ');
}

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, scope: string, parts: readonly unknown[]): void {
  const line = redact(render(parts));
  const stamp = new Date().toISOString();
  const message = `${stamp} [${level}] ${scope}: ${line}`;
  if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
  else console.log(message);
}

export interface Logger {
  info(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  error(...parts: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  return {
    info: (...parts) => emit('info', scope, parts),
    warn: (...parts) => emit('warn', scope, parts),
    error: (...parts) => emit('error', scope, parts),
  };
}

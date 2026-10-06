import fs from 'node:fs';

const names = new Set(['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError']);
const codes = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EROFS',
  'EISDIR',
  'ENOTDIR',
  'EMFILE',
  'ENFILE',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ABORT_ERR',
]);
export type ErrorDiagnostic = { name: string; code?: string };
export type OperationDiagnostic = {
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: 'done' | 'failed';
  error?: ErrorDiagnostic[];
};

// Raw messages, URLs, headers and stacks may contain credentials. Retain only
// known error categories, including bounded causes, for local troubleshooting.
export function errorDiagnostics(error: unknown): ErrorDiagnostic[] {
  const result: ErrorDiagnostic[] = [],
    seen = new Set<unknown>();
  for (
    let depth = 0;
    depth < 3 && error && typeof error === 'object' && !seen.has(error);
    depth++
  ) {
    seen.add(error);
    const value = error as { name?: unknown; code?: unknown; cause?: unknown };
    result.push({
      name: typeof value.name === 'string' && names.has(value.name) ? value.name : 'Error',
      ...(typeof value.code === 'string' && codes.has(value.code) ? { code: value.code } : {}),
    });
    error = value.cause;
  }
  return result;
}

export function writeDiagnostic(file: string, record: OperationDiagnostic): void {
  try {
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch (error) {
    // Diagnostics must not turn an already committed operation into a failure.
    process.stderr.write(
      JSON.stringify({ event: 'diagnostics_write_failed', error: errorDiagnostics(error) }) + '\n',
    );
  }
}

export function recordError(file: string, name: string, error: unknown): void {
  const time = new Date().toISOString();
  writeDiagnostic(file, {
    name,
    startedAt: time,
    endedAt: time,
    durationMs: 0,
    status: 'failed',
    error: errorDiagnostics(error),
  });
}

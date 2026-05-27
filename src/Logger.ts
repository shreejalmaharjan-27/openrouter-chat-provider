import vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

function ensureChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('ORCP');
  }
  return channel;
}

function ts(): string {
  return new Date().toISOString();
}

function serializeError(e: Error): string {
  const enriched: Record<string, unknown> = {
    name: e.name,
    message: e.message,
  };
  for (const key of Object.getOwnPropertyNames(e)) {
    if (key === 'name' || key === 'message' || key === 'stack') {
      continue;
    }
    const value = (e as unknown as Record<string, unknown>)[key];
    if (value instanceof Headers) {
      enriched[key] = Object.fromEntries(value.entries());
    } else if (value instanceof Response || value instanceof Request) {
      enriched[key] = `[${value.constructor.name}]`;
    } else {
      enriched[key] = value;
    }
  }
  let body = '';
  try {
    body = JSON.stringify(enriched, null, 2);
  } catch {
    body = `${e.name}: ${e.message}`;
  }
  return `${e.stack ?? `${e.name}: ${e.message}`}\n--- error props ---\n${body}`;
}

function write(level: string, args: unknown[]): void {
  const parts = args.map((a) => {
    if (a instanceof Error) {
      return serializeError(a);
    }
    if (typeof a === 'string') {
      return a;
    }
    try {
      return JSON.stringify(a, null, 2);
    } catch {
      return String(a);
    }
  });
  ensureChannel().appendLine(`[${ts()}] [${level}] ${parts.join(' ')}`);
}

export const log = {
  info: (...args: unknown[]): void => write('INFO', args),
  warn: (...args: unknown[]): void => write('WARN', args),
  error: (...args: unknown[]): void => write('ERROR', args),
  debug: (...args: unknown[]): void => write('DEBUG', args),
  show: (): void => ensureChannel().show(true),
  dispose: (): void => {
    channel?.dispose();
    channel = undefined;
  },
};

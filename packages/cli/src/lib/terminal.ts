import { AsyncLocalStorage } from 'node:async_hooks';
import { stripVTControlCharacters } from 'node:util';

export interface TerminalOptions { json?: boolean; interactive?: boolean; verbose?: boolean }
export type Event =
  | { kind: 'info' | 'success' | 'warning' | 'error' | 'progress' | 'heading'; message: string }
  | { kind: 'file'; status: 'create' | 'update' | 'unchanged' | 'conflict'; path: string }
  | { kind: 'values'; values: Record<string, string> };
export function interactive(options: TerminalOptions, streams = {
  input: Boolean(process.stdin.isTTY), output: Boolean(process.stdout.isTTY), env: process.env,
}): boolean {
  return streams.input && streams.output && !streams.env.CI && options.interactive !== false && !options.json;
}
export function terminalText(value: string): string {
  return [...stripVTControlCharacters(value)].filter(c => c === '\n' || (c.codePointAt(0)! >= 32 && c.codePointAt(0)! !== 127)).join('');
}
export class Terminal {
  readonly events: Event[] = [];
  private readonly color: boolean;
  constructor(readonly options: TerminalOptions = {}, private readonly write = (s: string) => { process.stdout.write(s); }, tty = Boolean(process.stdout.isTTY), env = process.env) {
    this.color = tty && !options.json && !env.CI && env.NO_COLOR === undefined && env.TERM !== 'dumb';
  }
  event(event: Event): void {
    this.events.push(event);
    if (this.options.json) return;
    let line: string;
    if (event.kind === 'file') line = `${event.status} ${event.path}`;
    else if (event.kind === 'values') {
      const width = Math.max(0, ...Object.keys(event.values).map(k => k.length));
      line = Object.entries(event.values).map(([k,v]) => `${k.padEnd(width + 3)}${v}`).join('\n');
    } else if (event.kind === 'heading') line = `\nSUPAGAME · ${event.message.toUpperCase()}\n`;
    else line = `${({ success: '✓ ', warning: '! ', error: '✗ ', progress: '… ', info: '' })[event.kind]}${event.message}`;
    line = terminalText(line);
    this.write(this.color && event.kind === 'heading' ? `\u001b[1m${line}\u001b[0m\n` : `${line}\n`);
  }
  heading(message: string): void { this.event({ kind: 'heading', message }); }
  values(values: Record<string, string>): void { this.event({ kind: 'values', values }); }
  finish(command: string, result: unknown = null, error?: { category: string; message: string; code: string }): void {
    if (this.options.json) this.write(JSON.stringify({ schemaVersion: 1, command, ok: !error, result, events: this.events, ...(error ? { error } : {}) }) + '\n');
    else if (error) this.event({ kind: 'error', message: error.message });
  }
}
const context = new AsyncLocalStorage<Terminal>();
export function withTerminal<T>(terminal: Terminal, operation: () => T): T { return context.run(terminal, operation); }
export function currentTerminal(): Terminal | undefined { return context.getStore(); }
export function log(message: string): void {
  const terminal = currentTerminal();
  if (terminal) terminal.event({ kind: 'info', message });
  else console.log(message);
}
export function fileEvent(status: 'create' | 'update' | 'unchanged' | 'conflict', path: string): void {
  const terminal = currentTerminal();
  if (terminal) terminal.event({ kind: 'file', status, path });
  else console.log(`${status} ${path}`);
}

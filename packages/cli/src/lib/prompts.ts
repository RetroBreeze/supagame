import { createInterface } from 'node:readline';
import { terminalText } from './terminal.ts';

export class Cancelled extends Error { constructor() { super('Cancelled; no project configuration was written.'); } }
interface TextOptions { default?: string; validate?: (value: string) => string | undefined }
export interface Choice { value: string; label: string }
export class Prompts {
  private readonly ask: (question: string) => Promise<string | null>;
  private readonly write: (message: string) => void;
  constructor(ask: (question: string) => Promise<string | null>, write: (message: string) => void) { this.ask = ask; this.write = write; }
  async text(question: string, options: TextOptions = {}): Promise<string> {
    for (;;) {
      const answer = await this.ask(terminalText(`? ${question}${options.default === undefined ? '' : ` [${options.default}]`}: `));
      if (answer === null) throw new Cancelled();
      const value = answer.trim() || options.default || '';
      const error = value.length > 16384 ? 'Input is too long.' : options.validate?.(value);
      if (!error) return value;
      this.write(`! ${error}`);
    }
  }
  private choices(choices: readonly Choice[]): void {
    if (!choices.length) throw new Error('No available choices. Configure the required prerequisite first.');
    choices.forEach((c,i) => this.write(`  ${i + 1}. ${terminalText(c.label)}`));
  }
  async select(question: string, choices: readonly Choice[], defaultValue?: string): Promise<string> {
    this.choices(choices);
    const resolve = (v: string) => choices.find(c => c.value === v) ?? (/^[1-9]\d*$/.test(v) ? choices[Number(v) - 1] : undefined);
    const value = await this.text(question, { ...(defaultValue === undefined ? {} : { default: defaultValue }), validate: v => resolve(v) ? undefined : 'Enter a listed choice number or value.' });
    return resolve(value)!.value;
  }
  async multiselect(question: string, choices: readonly Choice[], defaults: string[] = []): Promise<string[]> {
    this.choices(choices);
    const resolve = (v: string) => v === 'none' ? [] : v.split(',').map(s => s.trim()).map(s => choices.find(c => c.value === s) ?? (/^[1-9]\d*$/.test(s) ? choices[Number(s) - 1] : undefined));
    const value = await this.text(`${question} (comma-separated; none for no selection)`, { default: defaults.join(',') || 'none', validate: v => resolve(v).every(Boolean) ? undefined : 'Enter listed choice numbers or values separated by commas.' });
    return [...new Set(resolve(value).map(c => c!.value))];
  }
  async confirm(question: string, defaultValue = false): Promise<boolean> {
    return /^(y|yes)$/i.test(await this.text(`${question} (y/n)`, { default: defaultValue ? 'y' : 'n', validate: v => /^(y|yes|n|no)$/i.test(v) ? undefined : 'Enter yes or no.' }));
  }
  async integer(question: string, options: { default?: string; optional?: boolean; min?: number; max?: number } = {}): Promise<string | undefined> {
    const value = await this.text(question, { ...(options.default === undefined ? {} : { default: options.default }), validate: v => {
      if (options.optional && (v === '' || v === 'none')) return;
      if (!/^-?(0|[1-9]\d*)$/.test(v) || !Number.isSafeInteger(Number(v))) return 'Enter a decimal safe integer.';
      if ((options.min !== undefined && Number(v) < options.min) || (options.max !== undefined && Number(v) > options.max)) return 'Value is outside the accepted range.';
    } });
    return value === '' || value === 'none' ? undefined : value;
  }
}
// One interface owns the session: queued lines and EOF cannot be lost between questions.
export function terminalPrompts(): { prompts: Prompts; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const lines: string[] = [];
  let ended = false;
  let pending: ((value: string | null) => void) | undefined;
  const end = () => { ended = true; pending?.(null); pending = undefined; };
  rl.on('line', line => { if (pending) { const resolve = pending; pending = undefined; resolve(line); } else lines.push(line); });
  rl.on('close', end);
  rl.on('SIGINT', () => { lines.length = 0; end(); rl.close(); });
  return {
    prompts: new Prompts(question => {
      process.stdout.write(question);
      if (lines.length) return Promise.resolve(lines.shift()!);
      if (ended) return Promise.resolve(null);
      return new Promise(resolve => { pending = resolve; });
    }, message => { process.stdout.write(`${message}\n`); }),
    close: () => rl.close(),
  };
}

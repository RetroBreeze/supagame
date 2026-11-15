export class CliFailure extends Error {
  readonly category: 'validation' | 'authentication' | 'configuration' | 'deployment';
  readonly code: string;
  constructor(category: CliFailure['category'], code: string, message: string) {
    super(message); this.category = category; this.code = code;
  }
}

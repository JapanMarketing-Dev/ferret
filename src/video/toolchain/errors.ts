export class ToolchainError extends Error {
  constructor(public readonly code: 'unsupported-platform' | 'no-asset' | 'download' | 'checksum' | 'extract' | 'missing-bin' | 'aborted', message: string) {
    super(message);
    this.name = 'ToolchainError';
  }
}

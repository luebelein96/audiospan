export type CliExitCode = 0 | 1 | 2 | 3 | 4;

/** Exit codes: 1 generic failure, 2 usage error, 3 validation failure, 4 toolchain missing/failed. */
export class CliError extends Error {
  override readonly name = "CliError";
  readonly exitCode: CliExitCode;
  readonly hint: string | undefined;
  constructor(message: string, exitCode: CliExitCode = 1, hint?: string) {
    super(message);
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

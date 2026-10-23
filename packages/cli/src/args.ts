export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Tiny argv parser: `--flag`, `--flag=value`, `--flag value`, `-h`. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const name = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-") && !BOOLEAN_FLAGS.has(name)) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      flags[SHORT_FLAGS[arg] ?? arg.slice(1)] = true;
    } else {
      positionals.push(arg);
    }
  }
  const command = positionals.shift();
  return { command, positionals, flags };
}

const BOOLEAN_FLAGS = new Set(["help", "version", "force", "json", "verbose", "include-source", "no-validate", "launch", "quiet", "dev", "update", "watch", "install"]);
const SHORT_FLAGS: Record<string, string> = { "-h": "help", "-v": "version", "-f": "force", "-q": "quiet" };

export function flagString(flags: ParsedArgs["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagBoolean(flags: ParsedArgs["flags"], name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

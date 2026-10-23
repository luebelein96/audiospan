import type { RuntimeConnection } from "./connection.js";
import type { AudiospanError } from "./errors.js";
import type { AudiospanDiagnostic } from "./types.js";

/** Host services shared with instances and chains without exposing the host class. */
export interface HostInternals {
  readonly connection: RuntimeConnection;
  readonly diagnosticsEnabled: boolean;
  reportError(error: AudiospanError): void;
  reportDiagnostic(event: AudiospanDiagnostic): void;
  /** Called when an instance is disposed so chains and tables can drop it. */
  onInstanceDisposed(instanceId: string): void;
  /** Called when a chain is disposed so the host stops treating it as active. */
  onChainDisposed(chainId: string): void;
}

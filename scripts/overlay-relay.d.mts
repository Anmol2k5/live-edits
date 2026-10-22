import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface OverlayRelayOptions {
  publishToken?: string;
  viewToken?: string;
  templatesDirectory?: string;
  mediaDirectory?: string;
}

export interface OverlayRelayHandle {
  server: Server;
  listen: (port?: number, host?: string) => Promise<AddressInfo | string>;
  close: () => Promise<void>;
  publishToken: string;
  viewToken: string;
  bootId: string;
}

export function createOverlayRelay(
  options?: OverlayRelayOptions
): OverlayRelayHandle;

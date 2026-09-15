// Transport factory. Screens get their transport here and never import the
// implementations directly — the same instance is reused across screens so
// the connection survives navigation.

import { RealTransport } from "@/src/obd/real";
import type { ObdTransport } from "@/src/obd/transport";

let realTransport: RealTransport | null = null;

export function getTransport(): ObdTransport {
  if (!realTransport) realTransport = new RealTransport();
  return realTransport;
}

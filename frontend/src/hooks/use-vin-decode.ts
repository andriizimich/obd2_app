import { useCallback, useEffect, useState } from "react";

import { decodeVinRemote, VinDecodeOk, VinDecodePartial } from "@/src/api/vpic";
import { validateVin } from "@/src/utils/vin";

export type VinDecodeState =
  | { status: "idle" } // vin null or locally invalid
  | { status: "loading" }
  | { status: "ready"; result: VinDecodeOk | VinDecodePartial }
  | { status: "error"; reason: string; message: string };

export function useVinDecode(vin: string | null): {
  state: VinDecodeState;
  retry: () => void;
} {
  const [state, setState] = useState<VinDecodeState>({ status: "idle" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!vin || !validateVin(vin).valid) {
      setState({ status: "idle" });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    decodeVinRemote(vin).then((result) => {
      if (cancelled) return;
      if (result.status === "error") {
        setState({ status: "error", reason: result.reason, message: result.message });
      } else {
        setState({ status: "ready", result });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [vin, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return { state, retry };
}

import type { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";

export const handleTransferMeta: Handler<"transfer.meta"> = ({ gw, params }) => {
  if (!params || typeof params.transferId !== "number") {
    throw new RpcError(400, "transferId required");
  }
  gw.handleTransferMeta(params);
  return { ok: true };
};

export const handleTransferAccept: Handler<"transfer.accept"> = ({ gw, params }) => {
  if (!params || typeof params.transferId !== "number") {
    throw new RpcError(400, "transferId required");
  }
  gw.handleTransferAccept(params);
  return { ok: true };
};

export const handleTransferComplete: Handler<"transfer.complete"> = ({ gw, params }) => {
  if (!params || typeof params.transferId !== "number") {
    throw new RpcError(400, "transferId required");
  }
  gw.handleTransferComplete(params);
  return { ok: true };
};

export const handleTransferDone: Handler<"transfer.done"> = ({ gw, params }) => {
  if (!params || typeof params.transferId !== "number") {
    throw new RpcError(400, "transferId required");
  }
  gw.handleTransferDone(params);
  return { ok: true };
};

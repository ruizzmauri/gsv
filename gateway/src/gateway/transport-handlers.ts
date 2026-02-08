import type { RequestFrame } from "../protocol/frames";
import type { Gateway } from "../gateway";

export type TransportMethod = "connect" | "tool.invoke" | "tool.result";
export type TransportHandlerContext = { ws: WebSocket; frame: RequestFrame };
export type TransportHandler = (
  ctx: TransportHandlerContext,
) => Promise<void> | void;

export function buildTransportHandlers(
  gw: Gateway,
): Record<TransportMethod, TransportHandler> {
  return {
    connect: ({ ws, frame }) => gw.handleConnect(ws, frame),
    "tool.invoke": ({ ws, frame }) => gw.handleToolInvoke(ws, frame),
    "tool.result": ({ ws, frame }) => gw.handleToolResult(ws, frame),
  };
}

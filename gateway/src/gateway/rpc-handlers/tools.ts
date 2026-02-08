import type { EventFrame } from "../../protocol/frames";
import type { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";
import type { ToolInvokePayload } from "../../types";

export const handleToolsList: Handler<"tools.list"> = (gw) => ({
  tools: gw.getAllTools(),
});

export const handleToolRequest: Handler<"tool.request"> = (gw, params) => {
  if (!params?.callId || !params?.tool || !params?.sessionKey) {
    throw new RpcError(400, "callId, tool, and sessionKey required");
  }

  const resolved = gw.findNodeForTool(params.tool);
  if (!resolved) {
    throw new RpcError(404, `No node provides tool: ${params.tool}`);
  }

  const nodeWs = gw.nodes.get(resolved.nodeId);
  if (!nodeWs) {
    throw new RpcError(503, "Node not connected");
  }

  gw.pendingToolCalls[params.callId] = {
    kind: "session",
    sessionKey: params.sessionKey,
  };

  // Send the original (un-namespaced) tool name to the node
  const evt: EventFrame<ToolInvokePayload> = {
    type: "evt",
    event: "tool.invoke",
    payload: {
      callId: params.callId,
      tool: resolved.toolName,
      args: params.args ?? {},
    },
  };
  nodeWs.send(JSON.stringify(evt));

  return { status: "sent" };
};

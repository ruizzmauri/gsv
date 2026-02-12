import { NATIVE_TOOLS } from "./constants";
import type { ToolDefinition } from "../../protocol/tools";

export const getGatewayToolDefinitions = (): ToolDefinition[] => [
  {
    name: NATIVE_TOOLS.CONFIG_GET,
    description:
      "Inspect Gateway configuration. Returns masked full config by default, or a specific value when path is provided.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Optional dotted path (e.g., 'session.dmScope' or 'channels.whatsapp.allowFrom').",
        },
      },
      required: [],
    },
  },
  {
    name: NATIVE_TOOLS.LOGS_GET,
    description:
      "Fetch recent log lines from a connected node. If nodeId is omitted, it auto-selects when exactly one node is connected.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "Optional node id. Required when multiple nodes are connected.",
        },
        lines: {
          type: "number",
          description: "Optional number of lines (default 100, max 5000).",
        },
      },
      required: [],
    },
  },
];

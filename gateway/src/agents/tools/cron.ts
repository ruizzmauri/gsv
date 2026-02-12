import { NATIVE_TOOLS } from "./constants";
import type { ToolDefinition } from "../../protocol/tools";

export const getCronToolDefinitions = (): ToolDefinition[] => [
  {
    name: NATIVE_TOOLS.CRON,
    description:
      "Manage scheduled cron jobs. Actions: status, list, add, update, remove, run, runs. Legacy: start, trigger.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "status",
            "list",
            "add",
            "update",
            "remove",
            "run",
            "runs",
            "start",
            "trigger",
          ],
          description: "Cron action to execute.",
        },
        id: {
          type: "string",
          description: "Job id for update/remove/run(force).",
        },
        mode: {
          type: "string",
          enum: ["due", "force"],
          description: "Run mode for action=run.",
        },
        agentId: {
          type: "string",
          description:
            "Optional agent filter for list/status, or owner for add.",
        },
        includeDisabled: {
          type: "boolean",
          description: "Whether disabled jobs are included for action=list.",
        },
        limit: {
          type: "number",
          description: "Pagination limit for list/runs.",
        },
        offset: {
          type: "number",
          description: "Pagination offset for list/runs.",
        },
        job: {
          type: "object",
          description: "Job create payload for action=add.",
        },
        patch: {
          type: "object",
          description: "Job patch payload for action=update.",
        },
        jobId: {
          type: "string",
          description: "Job id filter for action=runs.",
        },
      },
      required: ["action"],
    },
  },
];

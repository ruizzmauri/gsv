import type { ToolDefinition } from "../../protocol/tools";
import { NATIVE_TOOL_PREFIX, NATIVE_TOOLS } from "./constants";
import { getCronToolDefinitions } from "./cron";
import { getGatewayToolDefinitions } from "./gateway";
import {
  deleteFile,
  listFiles,
  readFile,
  getWorkspaceToolDefinitions,
  writeFile,
} from "./workspace";

export * from "./constants";
export * from "./workspace";
export * from "./cron";
export * from "./gateway";

type NativeToolResult = { ok: boolean; result?: unknown; error?: string };
type NativeToolContext = {
  executeCronTool?: (args: Record<string, unknown>) => Promise<unknown>;
  executeConfigGet?: (args: Record<string, unknown>) => Promise<unknown>;
  executeLogsGet?: (args: Record<string, unknown>) => Promise<unknown>;
};

export function isNativeTool(toolName: string): boolean {
  return toolName.startsWith(NATIVE_TOOL_PREFIX);
}

export function getNativeToolDefinitions(): ToolDefinition[] {
  return [
    ...getWorkspaceToolDefinitions(),
    ...getGatewayToolDefinitions(),
    ...getCronToolDefinitions(),
  ];
}

/**
 * Execute a native tool
 * Returns { ok, result?, error? }
 */
export async function executeNativeTool(
  bucket: R2Bucket,
  agentId: string,
  toolName: string,
  args: Record<string, unknown>,
  context?: NativeToolContext,
): Promise<NativeToolResult> {
  const basePath = `agents/${agentId}`;

  try {
    switch (toolName) {
      case NATIVE_TOOLS.LIST_FILES:
        return await listFiles(
          bucket,
          basePath,
          args.path as string | undefined,
        );

      case NATIVE_TOOLS.READ_FILE:
        return await readFile(bucket, basePath, args.path as string);

      case NATIVE_TOOLS.WRITE_FILE:
        return await writeFile(
          bucket,
          basePath,
          args.path as string,
          args.content as string,
        );

      case NATIVE_TOOLS.DELETE_FILE:
        return await deleteFile(bucket, basePath, args.path as string);
      case NATIVE_TOOLS.CONFIG_GET: {
        if (!context?.executeConfigGet) {
          return {
            ok: false,
            error: "ConfigGet tool unavailable: executeConfigGet not configured",
          };
        }

        const payload = await context.executeConfigGet(args);
        return {
          ok: true,
          result: payload,
        };
      }
      case NATIVE_TOOLS.LOGS_GET: {
        if (!context?.executeLogsGet) {
          return {
            ok: false,
            error: "LogsGet tool unavailable: executeLogsGet not configured",
          };
        }

        const payload = await context.executeLogsGet(args);
        return {
          ok: true,
          result: payload,
        };
      }
      case NATIVE_TOOLS.CRON: {
        if (!context?.executeCronTool) {
          return {
            ok: false,
            error: "Cron tool unavailable: executeCronTool not configured",
          };
        }

        const payload = await context.executeCronTool(args);
        return {
          ok: true,
          result: payload,
        };
      }

      default:
        return { ok: false, error: `Unknown native tool: ${toolName}` };
    }
  } catch (e) {
    console.error(`[NativeTools] Error executing ${toolName}:`, e);
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

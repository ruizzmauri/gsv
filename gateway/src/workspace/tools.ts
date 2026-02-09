/*
 * Workspace Tools - Native R2 tools for agent workspace access
 *
 * These tools allow agents to read/write their own workspace files
 * directly through R2, without requiring a connected node.
 *
 * Tools are prefixed with "gsv__" to distinguish from node-provided tools.
 * The agent's workspace is scoped to: agents/{agentId}/
 */

import type { ToolDefinition } from "../protocol/tools";

export const WORKSPACE_TOOL_PREFIX = "gsv__";
export const WORKSPACE_TOOLS = {
  LIST_FILES: `${WORKSPACE_TOOL_PREFIX}ListFiles`,
  READ_FILE: `${WORKSPACE_TOOL_PREFIX}ReadFile`,
  WRITE_FILE: `${WORKSPACE_TOOL_PREFIX}WriteFile`,
  DELETE_FILE: `${WORKSPACE_TOOL_PREFIX}DeleteFile`,
};

export function getWorkspaceToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: WORKSPACE_TOOLS.LIST_FILES,
      description:
        "List files and directories in your workspace. Your workspace persists across sessions and contains your identity files (SOUL.md, IDENTITY.md, etc.), memory files, and any other files you create.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Directory path relative to workspace root (e.g., '/' for root, 'memory/' for memory directory). Defaults to '/'.",
          },
        },
        required: [],
      },
    },
    {
      name: WORKSPACE_TOOLS.READ_FILE,
      description:
        "Read a file from your workspace. Use this to read your identity files, memory files, or any files you've created.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "File path relative to workspace root (e.g., 'SOUL.md', 'memory/2024-01-15.md')",
          },
        },
        required: ["path"],
      },
    },
    {
      name: WORKSPACE_TOOLS.WRITE_FILE,
      description:
        "Write or update a file in your workspace. Use this to update your identity (SOUL.md, IDENTITY.md), create memory files, or store any data you need to persist. Creates parent directories automatically.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "File path relative to workspace root (e.g., 'SOUL.md', 'memory/2024-01-15.md')",
          },
          content: {
            type: "string",
            description: "Content to write to the file",
          },
        },
        required: ["path", "content"],
      },
    },
    {
      name: WORKSPACE_TOOLS.DELETE_FILE,
      description:
        "Delete a file from your workspace. Use with caution - deleted files cannot be recovered.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "File path relative to workspace root (e.g., 'BOOTSTRAP.md')",
          },
        },
        required: ["path"],
      },
    },
  ];
}

/**
 * Check if a tool name is a workspace tool
 */
export function isWorkspaceTool(toolName: string): boolean {
  return toolName.startsWith(WORKSPACE_TOOL_PREFIX);
}

/**
 * Execute a workspace tool
 * Returns { ok, result?, error? }
 */
export async function executeWorkspaceTool(
  bucket: R2Bucket,
  agentId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const basePath = `agents/${agentId}`;

  try {
    switch (toolName) {
      case WORKSPACE_TOOLS.LIST_FILES:
        return await listFiles(
          bucket,
          basePath,
          args.path as string | undefined,
        );

      case WORKSPACE_TOOLS.READ_FILE:
        return await readFile(bucket, basePath, args.path as string);

      case WORKSPACE_TOOLS.WRITE_FILE:
        return await writeFile(
          bucket,
          basePath,
          args.path as string,
          args.content as string,
        );

      case WORKSPACE_TOOLS.DELETE_FILE:
        return await deleteFile(bucket, basePath, args.path as string);

      default:
        return { ok: false, error: `Unknown workspace tool: ${toolName}` };
    }
  } catch (e) {
    console.error(`[WorkspaceTools] Error executing ${toolName}:`, e);
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Normalize and validate a path within the workspace
 */
function normalizePath(
  basePath: string,
  relativePath: string | undefined,
): string {
  // Default to root
  let path = (relativePath || "/").trim();

  // Remove leading slash for R2 path construction
  if (path.startsWith("/")) {
    path = path.slice(1);
  }

  // Prevent path traversal
  if (path.includes("..")) {
    throw new Error("Path traversal not allowed");
  }

  // Construct full path
  return path ? `${basePath}/${path}` : basePath;
}

/**
 * List files in a directory
 */
async function listFiles(
  bucket: R2Bucket,
  basePath: string,
  relativePath?: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const fullPath = normalizePath(basePath, relativePath);
  const prefix = fullPath.endsWith("/") ? fullPath : `${fullPath}/`;

  // List objects with this prefix
  const listed = await bucket.list({
    prefix: fullPath === basePath ? `${basePath}/` : prefix,
    delimiter: "/",
  });

  // Extract file names and directories
  const files: string[] = [];
  const directories: string[] = [];

  // Files (objects)
  for (const obj of listed.objects) {
    // Get relative path from workspace root
    const relPath = obj.key.replace(`${basePath}/`, "");
    if (relPath) {
      files.push(relPath);
    }
  }

  // Directories (common prefixes)
  for (const prefix of listed.delimitedPrefixes || []) {
    const relPath = prefix.replace(`${basePath}/`, "");
    if (relPath) {
      directories.push(relPath);
    }
  }

  return {
    ok: true,
    result: {
      path: relativePath || "/",
      files,
      directories,
    },
  };
}

/**
 * Read a file
 */
async function readFile(
  bucket: R2Bucket,
  basePath: string,
  relativePath: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  if (!relativePath) {
    return { ok: false, error: "path is required" };
  }

  const fullPath = normalizePath(basePath, relativePath);
  const object = await bucket.get(fullPath);

  if (!object) {
    return { ok: false, error: `File not found: ${relativePath}` };
  }

  const content = await object.text();

  return {
    ok: true,
    result: {
      path: relativePath,
      content,
      size: object.size,
      lastModified: object.uploaded?.toISOString(),
    },
  };
}

/**
 * Write a file
 */
async function writeFile(
  bucket: R2Bucket,
  basePath: string,
  relativePath: string,
  content: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  if (!relativePath) {
    return { ok: false, error: "path is required" };
  }
  if (content === undefined || content === null) {
    return { ok: false, error: "content is required" };
  }

  const fullPath = normalizePath(basePath, relativePath);

  // Determine content type based on extension
  let contentType = "text/plain";
  if (relativePath.endsWith(".md")) {
    contentType = "text/markdown";
  } else if (relativePath.endsWith(".json")) {
    contentType = "application/json";
  } else if (relativePath.endsWith(".yaml") || relativePath.endsWith(".yml")) {
    contentType = "text/yaml";
  }

  await bucket.put(fullPath, content, {
    httpMetadata: {
      contentType,
    },
  });

  console.log(`[WorkspaceTools] Wrote ${fullPath} (${content.length} bytes)`);

  return {
    ok: true,
    result: {
      path: relativePath,
      size: content.length,
      written: true,
    },
  };
}

/**
 * Delete a file
 */
async function deleteFile(
  bucket: R2Bucket,
  basePath: string,
  relativePath: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  if (!relativePath) {
    return { ok: false, error: "path is required" };
  }

  const fullPath = normalizePath(basePath, relativePath);

  // Check if file exists first
  const existing = await bucket.head(fullPath);
  if (!existing) {
    return { ok: false, error: `File not found: ${relativePath}` };
  }

  await bucket.delete(fullPath);

  console.log(`[WorkspaceTools] Deleted ${fullPath}`);

  return {
    ok: true,
    result: {
      path: relativePath,
      deleted: true,
    },
  };
}

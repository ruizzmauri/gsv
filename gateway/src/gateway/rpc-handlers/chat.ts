import { env } from "cloudflare:workers";
import { parseCommand } from "../commands";
import {
  formatDirectiveAck,
  isDirectiveOnly,
  parseDirectives,
} from "../directives";
import type { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";

export const handleChatSend: Handler<"chat.send"> = async ({ gw, params }) => {
  if (!params?.sessionKey || !params?.message) {
    throw new RpcError(400, "sessionKey and message required");
  }

  const canonicalSessionKey = gw.canonicalizeSessionKey(params.sessionKey);

  const messageText = params.message;

  // Check for slash commands first
  const command = parseCommand(messageText);
  if (command) {
    const commandResult = await gw.handleSlashCommandForChat(
      command,
      canonicalSessionKey,
    );

    if (commandResult.handled) {
      return {
        status: "command",
        command: command.name,
        response: commandResult.response,
        error: commandResult.error,
      };
    }
  }

  const fullConfig = gw.getFullConfig();
  const sessionStub = env.SESSION.getByName(canonicalSessionKey);

  // Parse inline directives. For provider-less model selectors (e.g. /m:o3),
  // resolve against the session's current provider, not the global default.
  let directives = parseDirectives(messageText);
  const needsProviderFallback =
    directives.hasModelDirective &&
    !directives.model &&
    !!directives.rawModelDirective &&
    !directives.rawModelDirective.includes("/");

  if (needsProviderFallback) {
    try {
      const info = await sessionStub.get();
      const fallbackProvider =
        info.settings.model?.provider || fullConfig.model.provider;
      directives = parseDirectives(messageText, fallbackProvider);
    } catch (e) {
      console.warn(
        `[Gateway] Failed to resolve session model provider for ${canonicalSessionKey}, using global default:`,
        e,
      );
      directives = parseDirectives(messageText, fullConfig.model.provider);
    }
  }

  // If message is only directives, acknowledge and return
  if (isDirectiveOnly(messageText)) {
    const ack = formatDirectiveAck(directives);
    return {
      status: "directive-only",
      response: ack,
      directives: {
        thinkLevel: directives.thinkLevel,
        model: directives.model,
      },
    };
  }

  const now = Date.now();
  const existing = gw.sessionRegistry[canonicalSessionKey];
  gw.sessionRegistry[canonicalSessionKey] = {
    sessionKey: canonicalSessionKey,
    createdAt: existing?.createdAt ?? now,
    lastActiveAt: now,
    label: existing?.label,
  };

  // Apply directive overrides for this message
  const messageOverrides: {
    thinkLevel?: string;
    model?: { provider: string; id: string };
  } = {};

  if (directives.thinkLevel) {
    messageOverrides.thinkLevel = directives.thinkLevel;
  }
  if (directives.model) {
    messageOverrides.model = directives.model;
  }

  const result = await sessionStub.chatSend(
    directives.cleaned, // Send cleaned message without directives
    params.runId ?? crypto.randomUUID(),
    JSON.parse(JSON.stringify(gw.getAllTools())),
    JSON.parse(JSON.stringify(gw.getRuntimeNodeInventory())),
    canonicalSessionKey,
    messageOverrides,
  );

  return {
    status: "started",
    runId: result.runId,
    directives:
      directives.hasThinkDirective || directives.hasModelDirective
        ? {
            thinkLevel: directives.thinkLevel,
            model: directives.model,
          }
        : undefined,
  };
};

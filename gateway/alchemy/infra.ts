/**
 * GSV Gateway Infrastructure Definition
 * 
 * This file defines the Cloudflare resources for GSV using Alchemy.
 * Can be used for both deployments and e2e testing.
 */
import alchemy from "alchemy";
import {
  Worker,
  WorkerStub,
  DurableObjectNamespace,
  R2Bucket,
  R2Object,
} from "alchemy/cloudflare";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type GsvInfraOptions = {
  /** Unique name prefix (use random suffix for tests) */
  name: string;
  /** Worker entrypoint */
  entrypoint?: string;
  /** Enable public URL (for testing) */
  url?: boolean;
  /** Deploy test channel alongside Gateway */
  withTestChannel?: boolean;
  /** Deploy WhatsApp channel */
  withWhatsApp?: boolean;
  /** Upload workspace templates */
  withTemplates?: boolean;
  /** Secrets to configure */
  secrets?: {
    authToken?: string;
    anthropicApiKey?: string;
  };
};

export async function createGsvInfra(opts: GsvInfraOptions) {
  const { 
    name, 
    entrypoint = "src/index.ts", 
    url = false, 
    withTestChannel = false,
    withWhatsApp = false,
    withTemplates = false,
    secrets = {},
  } = opts;

  // R2 bucket for storage (sessions, skills, media)
  const storage = await R2Bucket(`${name}-storage`, {
    name: `${name}-storage`,
    adopt: true,
  });

  // Upload workspace templates if requested
  if (withTemplates) {
    console.log("📁 Uploading workspace templates...");
    await uploadWorkspaceTemplates(storage);
  }

  // Use WorkerStub for circular service binding dependencies
  // Gateway references WhatsApp, WhatsApp references Gateway
  const gatewayStub = await WorkerStub(`${name}-gateway-stub`, { name });
  const whatsappStub = withWhatsApp
    ? await WorkerStub(`${name}-whatsapp-stub`, { name: `${name}-channel-whatsapp` })
    : undefined;

  // Main gateway worker
  const gateway = await Worker(`${name}-worker`, {
    name,
    entrypoint,
    adopt: true,
    bindings: {
      GATEWAY: DurableObjectNamespace("gateway", {
        className: "Gateway",
        sqlite: true,
      }),
      SESSION: DurableObjectNamespace("session", {
        className: "Session",
        sqlite: true,
      }),
      STORAGE: storage,
      ...(withWhatsApp && whatsappStub ? { CHANNEL_WHATSAPP: whatsappStub } : {}),
      // Secrets
      ...(secrets.authToken ? { AUTH_TOKEN: alchemy.secret(secrets.authToken) } : {}),
      ...(secrets.anthropicApiKey ? { ANTHROPIC_API_KEY: alchemy.secret(secrets.anthropicApiKey) } : {}),
    },
    url,
    compatibilityDate: "2026-01-28",
    compatibilityFlags: ["nodejs_compat"],
  });

  // Deploy WhatsApp channel - references Gateway via stub
  let whatsappChannel: Awaited<ReturnType<typeof Worker>> | undefined;
  
  if (withWhatsApp) {
    whatsappChannel = await Worker(`${name}-channel-whatsapp`, {
      name: `${name}-channel-whatsapp`,
      entrypoint: "../channels/whatsapp/src/index.ts",
      adopt: true,
      bindings: {
        WHATSAPP_ACCOUNT: DurableObjectNamespace("whatsapp-account", {
          className: "WhatsAppAccount",
          sqlite: true,
        }),
        GATEWAY: gatewayStub,
        // WhatsApp channel uses same auth token
        ...(secrets.authToken ? { AUTH_TOKEN: alchemy.secret(secrets.authToken) } : {}),
      },
      url: true,
      compatibilityDate: "2025-09-21",
      compatibilityFlags: ["nodejs_compat"],
      bundle: {
        alias: {
          "ws": "../channels/whatsapp/src/ws-shim.ts",
          "axios": "../channels/whatsapp/src/axios-shim.ts",
        },
      },
    });
  }

  // Optional test channel for e2e testing
  let testChannel: Awaited<ReturnType<typeof Worker>> | undefined;
  
  if (withTestChannel) {
    testChannel = await Worker(`${name}-test-channel`, {
      name: `${name}-test-channel`,
      entrypoint: "../channels/test/src/index.ts",
      adopt: true,
      bindings: {
        // Service binding to Gateway's entrypoint
        GATEWAY: {
          type: "service" as const,
          service: name,
          __entrypoint__: "GatewayEntrypoint",
        },
      },
      url: true,
      compatibilityDate: "2026-01-28",
      compatibilityFlags: ["nodejs_compat"],
    });
  }

  return { gateway, storage, whatsappChannel, testChannel };
}

/**
 * Upload workspace templates to R2 bucket
 */
async function uploadWorkspaceTemplates(
  bucket: Awaited<ReturnType<typeof R2Bucket>>,
  agentId: string = "main"
): Promise<void> {
  const files = ["SOUL.md", "USER.md", "MEMORY.md", "AGENTS.md", "HEARTBEAT.md"];
  // Templates are at repo root: gsv/templates/workspace/
  const templatesDir = path.resolve(__dirname, "../../templates/workspace");

  for (const file of files) {
    const filePath = path.join(templatesDir, file);
    if (!fs.existsSync(filePath)) {
      console.warn(`   Template not found: ${file}`);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const key = `agents/${agentId}/${file}`;

    await R2Object(`template-${agentId}-${file}`, {
      bucket,
      key,
      content,
    });

    console.log(`   Uploaded ${key}`);
  }
}

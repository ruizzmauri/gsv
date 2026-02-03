/**
 * GSV Gateway Infrastructure Definition
 * 
 * This file defines the Cloudflare resources for GSV using Alchemy.
 * Can be used for both deployments and e2e testing.
 */
import {
  Worker,
  DurableObjectNamespace,
  R2Bucket,
} from "alchemy/cloudflare";

export type GsvInfraOptions = {
  /** Unique name prefix (use random suffix for tests) */
  name: string;
  /** Worker entrypoint */
  entrypoint?: string;
  /** Enable public URL (for testing) */
  url?: boolean;
  /** Deploy test channel alongside Gateway */
  withTestChannel?: boolean;
};

export async function createGsvInfra(opts: GsvInfraOptions) {
  const { name, entrypoint = "src/index.ts", url = false, withTestChannel = false } = opts;

  // R2 bucket for storage (sessions, skills, media)
  const storage = await R2Bucket(`${name}-storage`, {
    name: `${name}-storage`,
    adopt: true,
  });

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
    },
    url,
    compatibilityDate: "2026-01-28",
    compatibilityFlags: ["nodejs_compat"],
    bundle: {
      format: "esm",
      target: "es2022",
    },
  });

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
          service: name, // Gateway's worker name
          __entrypoint__: "GatewayEntrypoint",
        },
      },
      url: true,
      compatibilityDate: "2026-01-28",
      compatibilityFlags: ["nodejs_compat"],
      bundle: {
        format: "esm",
        target: "es2022",
      },
    });
  }

  return { gateway, storage, testChannel };
}

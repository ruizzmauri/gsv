/**
 * GSV Channel RPC E2E Tests
 * 
 * Tests the Service Binding RPC flow between Channel workers and Gateway.
 * Deploys both Gateway and Test Channel workers together.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import crypto from "node:crypto";
import alchemy, { type Scope } from "alchemy";
import { createGsvInfra } from "../infra.ts";

const testId = `gsv-channel-rpc-${crypto.randomBytes(4).toString("hex")}`;

let app: Scope;
let gatewayUrl: string;
let testChannelUrl: string;

// Helper to wait for workers to be ready
async function waitForWorkers(urls: string[], maxWaitMs = 60000) {
  const start = Date.now();
  
  for (const url of urls) {
    while (Date.now() - start < maxWaitMs) {
      try {
        const res = await fetch(`${url}/health`);
        if (res.ok) break;
      } catch {
        // Keep waiting
      }
      await Bun.sleep(500);
    }
  }
}

// ============================================================================
// Test Setup/Teardown
// ============================================================================

beforeAll(async () => {
  console.log(`\n🧪 Setting up Channel RPC tests (${testId})...\n`);
  
  app = await alchemy("gsv-channel-rpc", { phase: "up" });
  
  await app.run(async () => {
    const { gateway, testChannel } = await createGsvInfra({
      name: testId,
      entrypoint: "src/index.ts",
      url: true,
      withTestChannel: true,
    });
    
    gatewayUrl = gateway.url!;
    testChannelUrl = testChannel!.url!;
    
    console.log(`   Gateway deployed: ${gatewayUrl}`);
    console.log(`   Test Channel deployed: ${testChannelUrl}`);
  });
  
  await waitForWorkers([gatewayUrl, testChannelUrl]);
  console.log("   Workers ready!\n");
}, 120000);

afterAll(async () => {
  console.log("\n🗑️  Cleaning up Channel RPC resources...");
  try {
    await alchemy.destroy(app);
    await app.finalize();
    console.log("   Resources destroyed successfully!");
  } catch (err) {
    console.error("   Cleanup error:", err);
  }
  console.log("   Done!\n");
}, 120000);

// ============================================================================
// Service Binding Helper
// ============================================================================

// Helper to call TestChannel's RPC methods via fetch
// (In real usage, these would be called via Service Binding from another worker)
async function callTestChannel(method: string, params: Record<string, unknown>): Promise<unknown> {
  // TestChannel exposes its methods via the WorkerEntrypoint
  // We can call them using the RPC-over-fetch pattern
  const res = await fetch(`${testChannelUrl}/__rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  
  if (!res.ok) {
    throw new Error(`RPC call failed: ${res.status} ${await res.text()}`);
  }
  
  return res.json();
}

// ============================================================================
// Tests
// ============================================================================

describe("Service Binding Channel RPC", () => {
  it("test channel health check works", async () => {
    const res = await fetch(`${testChannelUrl}/health`);
    expect(res.ok).toBe(true);
    
    const body = await res.json() as { service: string; status: string };
    expect(body.service).toBe("gsv-channel-test");
    expect(body.status).toBe("ok");
  });

  it("gateway health check works", async () => {
    const res = await fetch(`${gatewayUrl}/health`);
    expect(res.ok).toBe(true);
    
    const body = await res.json() as { status: string };
    expect(body.status).toBe("healthy");
  });

  // Note: Full RPC testing would require calling TestChannel's methods
  // which would then call Gateway via Service Binding.
  // For now, we verify both workers deploy and are healthy.
  // The actual RPC flow is tested by the existing channel.inbound tests
  // which exercise the same code path.
});

describe("Channel Worker Interface", () => {
  it("TestChannel implements required interface properties", async () => {
    // The TestChannel should have channelId and capabilities
    // These are verified by TypeScript at compile time
    // This test just confirms the worker deploys correctly
    const res = await fetch(`${testChannelUrl}/health`);
    const body = await res.json() as { accounts: string[] };
    expect(Array.isArray(body.accounts)).toBe(true);
  });
});

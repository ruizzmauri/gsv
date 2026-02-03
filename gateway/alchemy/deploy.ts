#!/usr/bin/env tsx
/**
 * Deploy GSV Gateway using Alchemy
 * 
 * Usage: 
 *   bun run deploy:alchemy              # Deploy gateway only
 *   bun run deploy:alchemy --whatsapp   # Deploy gateway + WhatsApp channel
 *   bun run deploy:alchemy --templates  # Deploy + upload workspace templates
 *   bun run deploy:alchemy --destroy    # Tear down resources
 * 
 * Environment variables:
 *   AUTH_TOKEN          - Auth token for Gateway & channels (auto-generated if not set)
 *   ANTHROPIC_API_KEY   - Anthropic API key for LLM calls
 */
import alchemy from "alchemy";
import { randomBytes } from "node:crypto";
import { createGsvInfra } from "./infra.ts";

const STACK_NAME = "gsv";
const WORKER_NAME = "gateway";

const withWhatsApp = process.argv.includes("--whatsapp");
const withTemplates = process.argv.includes("--templates");
const isDestroy = process.argv.includes("--destroy");

// Generate AUTH_TOKEN if not provided
const authToken = process.env.AUTH_TOKEN || randomBytes(32).toString("hex");
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

console.log(`\n🚀 GSV Deployment`);
console.log(`   Stack: ${STACK_NAME}`);
console.log(`   WhatsApp: ${withWhatsApp ? "yes" : "no"}`);
console.log(`   Templates: ${withTemplates ? "yes" : "no"}`);
console.log(`   Auth Token: ${process.env.AUTH_TOKEN ? "from env" : "auto-generated"}`);
console.log(`   Anthropic Key: ${anthropicApiKey ? "configured" : "NOT SET"}`);
console.log("");

const app = await alchemy(STACK_NAME, {
  phase: isDestroy ? "destroy" : "up",
  stateDir: ".alchemy",
  // Password for encrypting secrets in state files
  password: process.env.ALCHEMY_PASSWORD || "gsv-deploy-secrets",
});

const { gateway, storage, whatsappChannel } = await createGsvInfra({
  name: WORKER_NAME,
  entrypoint: "src/index.ts",
  url: true,
  withWhatsApp,
  withTemplates,
  secrets: {
    authToken,
    anthropicApiKey,
  },
});

if (!isDestroy) {
  console.log("\n✅ Deployed successfully!\n");
  console.log(`   Gateway:  ${gateway.url}`);
  console.log(`   Storage:  ${storage.name}`);
  
  if (whatsappChannel) {
    console.log(`   WhatsApp: ${whatsappChannel.url}`);
  }

  // Print auth token if it was auto-generated
  if (!process.env.AUTH_TOKEN) {
    console.log("\n🔑 Generated Auth Token (save this!):");
    console.log(`   ${authToken}`);
  }

  if (!anthropicApiKey) {
    console.log("\n⚠️  Warning: ANTHROPIC_API_KEY not set. Re-run with:");
    console.log(`   ANTHROPIC_API_KEY=sk-... bun alchemy/deploy.ts --whatsapp --templates`);
  }

  // Print CLI config commands
  console.log("\n📋 Configure CLI:");
  console.log(`   gsv init`);
  console.log(`   gsv local-config set gateway.url ${gateway.url?.replace("https://", "wss://")}/ws`);
  console.log(`   gsv local-config set gateway.token ${authToken}`);
  
  if (whatsappChannel) {
    console.log(`   gsv local-config set channels.whatsapp.url ${whatsappChannel.url}`);
    console.log(`   gsv local-config set channels.whatsapp.token ${authToken}`);
    console.log("");
    console.log("   Then login to WhatsApp:");
    console.log(`   gsv channel whatsapp login`);
  }
  
  console.log("");
} else {
  console.log("\n✅ Resources destroyed!");
}

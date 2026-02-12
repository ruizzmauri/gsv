import { describe, expect, it } from "vitest";
import {
  buildAgentSessionKey,
  canonicalizeMainSessionAlias,
  isMainSessionKey,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
} from "./routing";

describe("session routing", () => {
  it("resolves canonical agent main session key", () => {
    expect(
      resolveAgentMainSessionKey({ agentId: "Ops", mainKey: "Primary" }),
    ).toBe("agent:ops:primary");
  });

  it("canonicalizes main aliases", () => {
    expect(
      canonicalizeMainSessionAlias({
        agentId: "main",
        sessionKey: "main",
        mainKey: "primary",
      }),
    ).toBe("agent:main:primary");

    expect(
      canonicalizeMainSessionAlias({
        agentId: "main",
        sessionKey: "agent:main:main",
        mainKey: "primary",
      }),
    ).toBe("agent:main:primary");
  });

  it("maps DMs to canonical main by default", () => {
    const key = buildAgentSessionKey({
      agentId: "main",
      channel: "whatsapp",
      accountId: "default",
      peer: { kind: "dm", id: "+12345" },
      dmScope: "main",
      mainKey: "main",
    });

    expect(key).toBe("agent:main:main");
  });

  it("supports per-account-channel-peer DM scope", () => {
    const key = buildAgentSessionKey({
      agentId: "main",
      channel: "whatsapp",
      accountId: "phone-1",
      peer: { kind: "dm", id: "+12345" },
      dmScope: "per-account-channel-peer",
      mainKey: "main",
    });

    expect(key).toBe("agent:main:whatsapp:phone-1:dm:+12345");
  });

  it("treats canonical main aliases as main sessions", () => {
    expect(
      isMainSessionKey({
        sessionKey: "agent:main:primary",
        mainKey: "primary",
        dmScope: "main",
      }),
    ).toBe(true);

    expect(
      isMainSessionKey({
        sessionKey: "agent:main:whatsapp:dm:+12345",
        mainKey: "primary",
        dmScope: "main",
      }),
    ).toBe(true);

    expect(
      isMainSessionKey({
        sessionKey: "agent:main:whatsapp:dm:+12345",
        mainKey: "primary",
        dmScope: "per-channel-peer",
      }),
    ).toBe(false);
  });

  it("extracts agent id from session key", () => {
    expect(resolveAgentIdFromSessionKey("agent:work:main")).toBe("work");
    expect(resolveAgentIdFromSessionKey("main", "ops")).toBe("ops");
  });
});

import { describe, it, expect } from "vitest";
import { normalizeE164, isAllowedSender, type GsvConfig, DEFAULT_CONFIG } from "./config";

describe("normalizeE164", () => {
  it("handles E.164 format with plus", () => {
    expect(normalizeE164("+31628552611")).toBe("+31628552611");
  });

  it("handles digits only (adds plus)", () => {
    expect(normalizeE164("31628552611")).toBe("+31628552611");
  });

  it("handles WhatsApp JID format", () => {
    expect(normalizeE164("31628552611@s.whatsapp.net")).toBe("+31628552611");
  });

  it("handles WhatsApp JID with device suffix", () => {
    expect(normalizeE164("31628552611:0@s.whatsapp.net")).toBe("+31628552611");
  });

  it("handles @c.us JID format", () => {
    expect(normalizeE164("31628552611@c.us")).toBe("+31628552611");
  });

  it("handles LID format (strips to digits)", () => {
    // LID JIDs like "55156188147823@lid" - we just extract the digits
    // Note: LID numbers aren't real phone numbers, but we normalize them anyway
    expect(normalizeE164("55156188147823@lid")).toBe("+55156188147823");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeE164("")).toBe("");
  });

  it("strips non-digit characters", () => {
    expect(normalizeE164("+31 (6) 28-55-2611")).toBe("+31628552611");
  });
});

describe("isAllowedSender", () => {
  const baseConfig: GsvConfig = {
    ...DEFAULT_CONFIG,
    channels: {
      whatsapp: {
        dmPolicy: "allowlist",
        allowFrom: ["+31628552611"],
      },
    },
  };

  describe("allowlist policy", () => {
    it("allows sender in allowlist", () => {
      const result = isAllowedSender(baseConfig, "whatsapp", "+31628552611");
      expect(result.allowed).toBe(true);
    });

    it("blocks sender not in allowlist", () => {
      const result = isAllowedSender(baseConfig, "whatsapp", "+1234567890");
      expect(result.allowed).toBe(false);
      expect(result.needsPairing).toBeUndefined();
    });

    it("normalizes sender ID for comparison", () => {
      const result = isAllowedSender(baseConfig, "whatsapp", "31628552611@s.whatsapp.net");
      expect(result.allowed).toBe(true);
    });

    it("allows wildcard", () => {
      const config: GsvConfig = {
        ...baseConfig,
        channels: {
          whatsapp: {
            dmPolicy: "allowlist",
            allowFrom: ["*"],
          },
        },
      };
      const result = isAllowedSender(config, "whatsapp", "+9999999999");
      expect(result.allowed).toBe(true);
    });
  });

  describe("pairing policy", () => {
    const pairingConfig: GsvConfig = {
      ...baseConfig,
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: ["+31628552611"],
        },
      },
    };

    it("allows sender in allowlist", () => {
      const result = isAllowedSender(pairingConfig, "whatsapp", "+31628552611");
      expect(result.allowed).toBe(true);
    });

    it("marks unknown sender as needing pairing", () => {
      const result = isAllowedSender(pairingConfig, "whatsapp", "+1234567890");
      expect(result.allowed).toBe(false);
      expect(result.needsPairing).toBe(true);
    });
  });

  describe("open policy", () => {
    const openConfig: GsvConfig = {
      ...baseConfig,
      channels: {
        whatsapp: {
          dmPolicy: "open",
          allowFrom: [],
        },
      },
    };

    it("allows any sender", () => {
      const result = isAllowedSender(openConfig, "whatsapp", "+9999999999");
      expect(result.allowed).toBe(true);
    });
  });

  describe("non-whatsapp channels", () => {
    it("allows all senders for non-whatsapp channels", () => {
      const result = isAllowedSender(baseConfig, "telegram", "+9999999999");
      expect(result.allowed).toBe(true);
    });
  });
});

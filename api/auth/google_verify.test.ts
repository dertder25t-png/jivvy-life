import { describe, it, expect } from "vitest";
import { isValidRedirectUri, checkGoogleClaims } from "./google_verify";

const NOW = 1_700_000_000_000;
const good = {
  aud: "cid", iss: "https://accounts.google.com", email: "a@b.co",
  email_verified: "true", exp: String(NOW / 1000 + 600), sub: "123",
};

describe("isValidRedirectUri", () => {
  it("accepts loopback callback", () => {
    expect(isValidRedirectUri("http://127.0.0.1:53682/callback")).toBe(true);
  });
  it.each([
    "https://127.0.0.1:5000/callback", "http://localhost:5000/callback",
    "http://127.0.0.1/callback", "http://127.0.0.1:5000/callback/x",
    "http://127.0.0.1:5000/callback?x=1", "http://evil.com/http://127.0.0.1:5000/callback",
    "http://127.0.0.1:123456/callback", "http://127.0.0.1:99999/callback", "", 5,
  ])("rejects %s", (u) => expect(isValidRedirectUri(u as any)).toBe(false));
});

describe("checkGoogleClaims", () => {
  it("accepts good claims", () => expect(checkGoogleClaims(good, "cid", NOW)).toBeNull());
  it("accepts bare iss and boolean verified", () => {
    expect(checkGoogleClaims({ ...good, iss: "accounts.google.com", email_verified: true }, "cid", NOW)).toBeNull();
  });
  it("rejects wrong aud", () => expect(checkGoogleClaims(good, "other", NOW)).toBe("bad aud"));
  it("rejects bad iss", () => expect(checkGoogleClaims({ ...good, iss: "https://evil.com" }, "cid", NOW)).toBe("bad iss"));
  it("rejects unverified email", () => {
    expect(checkGoogleClaims({ ...good, email_verified: "false" }, "cid", NOW)).toBe("email not verified");
    expect(checkGoogleClaims({ ...good, email_verified: undefined }, "cid", NOW)).toBe("email not verified");
  });
  it("rejects expired", () => expect(checkGoogleClaims({ ...good, exp: String(NOW / 1000 - 1) }, "cid", NOW)).toBe("expired"));
  it("rejects missing sub", () => expect(checkGoogleClaims({ ...good, sub: "" }, "cid", NOW)).toBe("no sub"));
});

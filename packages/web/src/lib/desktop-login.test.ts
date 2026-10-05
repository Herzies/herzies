import { describe, expect, it } from "vitest";
import {
  DESKTOP_CALLBACK_URL,
  isLegacyDesktopPort,
  isValidLoginState,
} from "./desktop-login";

describe("desktop login handoff", () => {
  it("always posts to the fixed loopback callback", () => {
    expect(new URL(DESKTOP_CALLBACK_URL).host).toBe("127.0.0.1:8974");
  });

  it("accepts only a 32-hex-char state", () => {
    expect(isValidLoginState("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isValidLoginState(null)).toBe(false);
    expect(isValidLoginState("")).toBe(false);
    expect(isValidLoginState("0123456789ABCDEF0123456789ABCDEF")).toBe(false);
    expect(isValidLoginState("0123456789abcdef")).toBe(false);
    expect(isValidLoginState("0123456789abcdef0123456789abcdef&x=1")).toBe(
      false,
    );
  });

  it("honours only the legacy desktop port", () => {
    expect(isLegacyDesktopPort("8974")).toBe(true);
    expect(isLegacyDesktopPort("1@evil.com/x?")).toBe(false);
    expect(isLegacyDesktopPort("8974@evil.com")).toBe(false);
    expect(isLegacyDesktopPort("80/x")).toBe(false);
    expect(isLegacyDesktopPort("8975")).toBe(false);
    expect(isLegacyDesktopPort("")).toBe(false);
    expect(isLegacyDesktopPort(null)).toBe(false);
  });
});

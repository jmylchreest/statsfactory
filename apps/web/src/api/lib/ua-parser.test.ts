import { describe, it, expect } from "vitest";
import { parseUserAgent } from "./ua-parser";

describe("parseUserAgent", () => {
  describe("null/empty input", () => {
    it("returns empty dims for null", () => {
      expect(parseUserAgent(null)).toEqual({});
    });

    it("returns empty dims for empty string", () => {
      // Empty string won't match SDK or browser patterns
      const dims = parseUserAgent("");
      expect(dims["sdk.name"]).toBeUndefined();
    });
  });

  describe("SDK User-Agent parsing", () => {
    it("parses full SDK UA string", () => {
      const dims = parseUserAgent(
        "statsfactory-sdk-go/0.1.0 (tinct/0.1.27; linux; amd64)",
      );
      expect(dims).toEqual({
        "sdk.name": "statsfactory-sdk-go",
        "sdk.version": "0.1.0",
        "client.name": "tinct",
        "client.version": "0.1.27",
        "client.os": "linux",
        "client.arch": "amd64",
      });
    });

    it("parses SDK UA with pre-release version", () => {
      const dims = parseUserAgent(
        "statsfactory-sdk-go/1.0.0-beta.1 (myapp/2.0.0; darwin; arm64)",
      );
      expect(dims["sdk.version"]).toBe("1.0.0-beta.1");
      expect(dims["client.os"]).toBe("darwin");
      expect(dims["client.arch"]).toBe("arm64");
    });

    it("parses SDK UA with typescript SDK", () => {
      const dims = parseUserAgent(
        "statsfactory-sdk-ts/0.2.0 (webapp/1.0.0; browser; wasm)",
      );
      expect(dims["sdk.name"]).toBe("statsfactory-sdk-ts");
      expect(dims["client.name"]).toBe("webapp");
    });

    it("handles SDK UA with missing client version", () => {
      const dims = parseUserAgent(
        "statsfactory-sdk-go/0.1.0 (tinct; linux; amd64)",
      );
      expect(dims["client.name"]).toBe("tinct");
      expect(dims["client.version"]).toBeUndefined();
    });

    it("handles SDK UA with only client info", () => {
      const dims = parseUserAgent(
        "statsfactory-sdk-go/0.1.0 (tinct/1.0.0)",
      );
      expect(dims["sdk.name"]).toBe("statsfactory-sdk-go");
      expect(dims["client.name"]).toBe("tinct");
      expect(dims["client.version"]).toBe("1.0.0");
      expect(dims["client.os"]).toBeUndefined();
      expect(dims["client.arch"]).toBeUndefined();
    });
  });

  describe("browser User-Agent parsing", () => {
    it("parses Chrome on Windows", () => {
      const dims = parseUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      );
      expect(dims["client.browser"]).toBe("Chrome");
      expect(dims["client.browser_version"]).toBe("130");
      expect(dims["client.os"]).toBe("Windows");
      expect(dims["client.device_type"]).toBe("desktop");
    });

    it("parses Firefox on Linux", () => {
      const dims = parseUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
      );
      expect(dims["client.browser"]).toBe("Firefox");
      expect(dims["client.browser_version"]).toBe("131");
      expect(dims["client.os"]).toBe("Linux");
      expect(dims["client.device_type"]).toBe("desktop");
    });

    it("parses Edge (detects before Chrome)", () => {
      const dims = parseUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      );
      expect(dims["client.browser"]).toBe("Edge");
      expect(dims["client.os"]).toBe("Windows");
    });

    it("parses Safari on macOS", () => {
      const dims = parseUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      );
      expect(dims["client.browser"]).toBe("Safari");
      expect(dims["client.os"]).toBe("macOS");
      expect(dims["client.device_type"]).toBe("desktop");
    });

    it("detects mobile device type for iPhone", () => {
      const dims = parseUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      );
      expect(dims["client.os"]).toBe("iOS");
      expect(dims["client.device_type"]).toBe("mobile");
    });

    it("detects tablet device type for iPad", () => {
      const dims = parseUserAgent(
        "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      );
      expect(dims["client.os"]).toBe("iOS");
      expect(dims["client.device_type"]).toBe("tablet");
    });

    it("detects Android mobile", () => {
      const dims = parseUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      );
      expect(dims["client.os"]).toBe("Android");
      expect(dims["client.device_type"]).toBe("mobile");
    });
  });
});

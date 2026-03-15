/**
 * Parse the SDK User-Agent header into dimension key-value pairs.
 *
 * SDK format:
 *   statsfactory-sdk-go/0.1.0 (tinct/0.1.27; linux; amd64)
 *
 * Extracted dimensions:
 *   sdk.name        = "statsfactory-sdk-go"
 *   sdk.version     = "0.1.0"
 *   client.name     = "tinct"
 *   client.version  = "0.1.27"
 *   client.os       = "linux"
 *   client.arch     = "amd64"
 *
 * For browser User-Agents, we do a simpler parse:
 *   client.browser         = "Chrome"
 *   client.browser_version = "130"
 *   client.os              = "Windows"
 *   client.device_type     = "desktop"
 */

export type UaDimensions = Record<string, string>;

// Matches: statsfactory-sdk-<lang>/<version> (<client>/<ver>; <os>; <arch>)
const SDK_UA_RE =
  /^(statsfactory-sdk-\w+)\/([\d.]+(?:-[\w.]+)?)\s*\(([^)]+)\)$/;

export function parseUserAgent(ua: string | null): UaDimensions {
  if (!ua) return {};

  // Try SDK User-Agent first
  const sdkMatch = ua.match(SDK_UA_RE);
  if (sdkMatch) {
    return parseSdkUa(sdkMatch);
  }

  // Fall back to browser UA parsing
  return parseBrowserUa(ua);
}

function parseSdkUa(match: RegExpMatchArray): UaDimensions {
  const dims: UaDimensions = {};
  dims["sdk.name"] = match[1];
  dims["sdk.version"] = match[2];

  const parts = match[3].split(";").map((s) => s.trim());
  if (parts.length >= 1) {
    const clientParts = parts[0].split("/");
    dims["client.name"] = clientParts[0];
    if (clientParts[1]) {
      dims["client.version"] = clientParts[1];
    }
  }
  if (parts.length >= 2) {
    dims["client.os"] = parts[1];
  }
  if (parts.length >= 3) {
    dims["client.arch"] = parts[2];
  }

  return dims;
}

// Simple browser UA patterns — not exhaustive, but covers the common cases
const BROWSER_PATTERNS: [RegExp, string][] = [
  [/Edg\/([\d.]+)/, "Edge"],
  [/OPR\/([\d.]+)/, "Opera"],
  [/Chrome\/([\d.]+)/, "Chrome"],
  [/Safari\/([\d.]+)/, "Safari"],
  [/Firefox\/([\d.]+)/, "Firefox"],
];

const OS_PATTERNS: [RegExp, string][] = [
  [/iPhone|iPad/, "iOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Windows NT/, "Windows"],
  [/Mac OS X/, "macOS"],
  [/Linux/, "Linux"],
];

function parseBrowserUa(ua: string): UaDimensions {
  const dims: UaDimensions = {};

  for (const [re, name] of BROWSER_PATTERNS) {
    const m = ua.match(re);
    if (m) {
      dims["client.browser"] = name;
      dims["client.browser_version"] = m[1].split(".")[0]; // major only
      break;
    }
  }

  for (const [re, name] of OS_PATTERNS) {
    if (re.test(ua)) {
      dims["client.os"] = name;
      break;
    }
  }

  // Device type heuristic
  if (/Mobile|Android.*Mobile|iPhone/.test(ua)) {
    dims["client.device_type"] = "mobile";
  } else if (/iPad|Tablet|Android(?!.*Mobile)/.test(ua)) {
    dims["client.device_type"] = "tablet";
  } else {
    dims["client.device_type"] = "desktop";
  }

  return dims;
}

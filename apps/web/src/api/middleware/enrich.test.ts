import { describe, it, expect } from "vitest";
import { extractGeoDimensions, extractNetDimensions } from "./enrich";

describe("extractGeoDimensions", () => {
  const fullCf = {
    country: "NZ",
    continent: "OC",
    timezone: "Pacific/Auckland",
    region: "WLG",
    city: "Wellington",
    latitude: "-41.2865",
    longitude: "174.7762",
  };

  it("returns empty for undefined cf", () => {
    expect(extractGeoDimensions(undefined, "country")).toEqual({});
  });

  it("returns empty for precision 'none'", () => {
    expect(extractGeoDimensions(fullCf, "none")).toEqual({});
  });

  it("returns country-level dims for precision 'country'", () => {
    const dims = extractGeoDimensions(fullCf, "country");
    expect(dims["geo.country"]).toBe("NZ");
    expect(dims["geo.continent"]).toBe("OC");
    expect(dims["geo.timezone"]).toBe("Pacific/Auckland");
    // Should NOT include city-level
    expect(dims["geo.city"]).toBeUndefined();
    expect(dims["geo.region"]).toBeUndefined();
    expect(dims["geo.latitude"]).toBeUndefined();
    expect(dims["geo.longitude"]).toBeUndefined();
  });

  it("returns city-level dims for precision 'city'", () => {
    const dims = extractGeoDimensions(fullCf, "city");
    expect(dims["geo.country"]).toBe("NZ");
    expect(dims["geo.continent"]).toBe("OC");
    expect(dims["geo.city"]).toBe("Wellington");
    expect(dims["geo.region"]).toBe("WLG");
    expect(dims["geo.latitude"]).toBe("-41.2865");
    expect(dims["geo.longitude"]).toBe("174.7762");
  });

  it("handles partial cf data gracefully", () => {
    const dims = extractGeoDimensions({ country: "US" }, "country");
    expect(dims["geo.country"]).toBe("US");
    expect(dims["geo.continent"]).toBeUndefined();
  });
});

describe("extractNetDimensions", () => {
  it("returns empty for undefined cf", () => {
    expect(extractNetDimensions(undefined)).toEqual({});
  });

  it("extracts all network dimensions", () => {
    const dims = extractNetDimensions({
      asn: 13335,
      asOrganization: "Cloudflare Inc",
      colo: "SYD",
      tlsVersion: "TLSv1.3",
      httpProtocol: "HTTP/2",
    });
    expect(dims["net.asn"]).toBe("13335");
    expect(dims["net.as_org"]).toBe("Cloudflare Inc");
    expect(dims["net.colo"]).toBe("SYD");
    expect(dims["net.tls_version"]).toBe("TLSv1.3");
    expect(dims["net.http_protocol"]).toBe("HTTP/2");
  });

  it("handles partial cf data", () => {
    const dims = extractNetDimensions({ colo: "AKL" });
    expect(dims["net.colo"]).toBe("AKL");
    expect(dims["net.asn"]).toBeUndefined();
  });
});

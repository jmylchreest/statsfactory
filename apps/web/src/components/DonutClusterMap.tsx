/**
 * DonutClusterMap — MapLibre GL JS map with donut-chart cluster markers.
 *
 * Renders matrix data on an interactive map. Each marker position comes
 * from a geo dimension (geo.country centroid, or geo.latitude/longitude).
 * Donut segments show the breakdown of a non-geo dimension, coloured
 * using the deterministic dimColorHex() hash.
 *
 * Clustering is handled by MapLibre's built-in GeoJSON source clustering.
 * The donut SVG is generated inline (~50 lines, from the official
 * MapLibre "Display HTML clusters with custom properties" example).
 *
 * Props:
 *   matrixData   — rows from the /v1/query/matrix endpoint
 *   geoDim       — the geo dimension key used for positioning ("geo.country", "geo.latitude", etc.)
 *   segmentDim   — the non-geo dimension key used for donut segments ("client.os", "event_name", etc.)
 *   lngDim       — if geoDim is "geo.latitude", this is the longitude dim key
 */

import { useEffect, useRef, useCallback, useState } from "react";
import maplibregl from "maplibre-gl";
import { dimColorHex } from "./dim-color";
import { getCountryCentroid } from "./country-centroids";
import type { MatrixRow } from "./types";

// ── Types ──────────────────────────────────────────────────────────────────

interface DonutClusterMapProps {
  matrixData: MatrixRow[];
  geoDim: string;
  segmentDim: string;
  lngDim?: string; // only needed when geoDim is "geo.latitude"
  height?: number;
}

// ── Free tile source (no API key) ──────────────────────────────────────────

const DARK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  name: "Dark",
  sources: {
    "osm-tiles": {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
      ],
      tileSize: 256,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    },
  },
  layers: [
    {
      id: "osm-tiles",
      type: "raster",
      source: "osm-tiles",
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};

// ── Donut SVG helpers ──────────────────────────────────────────────────────

function donutSegment(
  start: number,
  end: number,
  r: number,
  r0: number,
  color: string,
): string {
  if (end - start === 1) end -= 0.00001;
  const a0 = 2 * Math.PI * (start - 0.25);
  const a1 = 2 * Math.PI * (end - 0.25);
  const x0 = Math.cos(a0),
    y0 = Math.sin(a0);
  const x1 = Math.cos(a1),
    y1 = Math.sin(a1);
  const largeArc = end - start > 0.5 ? 1 : 0;

  return `<path d="M ${r + r0 * x0} ${r + r0 * y0} L ${r + r * x0} ${
    r + r * y0
  } A ${r} ${r} 0 ${largeArc} 1 ${r + r * x1} ${r + r * y1} L ${
    r + r0 * x1
  } ${r + r0 * y1} A ${r0} ${r0} 0 ${largeArc} 0 ${r + r0 * x0} ${
    r + r0 * y0
  }" fill="${color}" opacity="0.85" />`;
}

function createDonutChart(
  segmentValues: string[],
  props: Record<string, number>,
): HTMLElement {
  const counts: number[] = [];
  const colors: string[] = [];
  const offsets: number[] = [];
  let total = 0;

  for (const val of segmentValues) {
    const count = props[`seg_${val}`] ?? 0;
    if (count <= 0) continue;
    colors.push(dimColorHex(val));
    counts.push(count);
    offsets.push(total);
    total += count;
  }

  if (total === 0) {
    const el = document.createElement("div");
    return el;
  }

  const fontSize = total >= 1000 ? 22 : total >= 100 ? 20 : total >= 10 ? 18 : 16;
  const r = total >= 1000 ? 50 : total >= 100 ? 32 : total >= 10 ? 24 : 18;
  const r0 = Math.round(r * 0.6);
  const w = r * 2;

  let html = `<div><svg width="${w}" height="${w}" viewBox="0 0 ${w} ${w}" text-anchor="middle" style="font: ${fontSize}px sans-serif; display: block">`;

  for (let i = 0; i < counts.length; i++) {
    html += donutSegment(
      offsets[i] / total,
      (offsets[i] + counts[i]) / total,
      r,
      r0,
      colors[i],
    );
  }

  html += `<circle cx="${r}" cy="${r}" r="${r0}" fill="#111827" />`;
  html += `<text dominant-baseline="central" transform="translate(${r}, ${r})" fill="#d1d5db" style="font-size: ${fontSize}px">${total.toLocaleString()}</text>`;
  html += `</svg></div>`;

  const el = document.createElement("div");
  el.innerHTML = html;
  el.style.cursor = "pointer";
  return el.firstChild as HTMLElement;
}

// ── Tooltip ────────────────────────────────────────────────────────────────

function createTooltipHTML(
  segmentValues: string[],
  props: Record<string, number>,
  geoValue?: string,
): string {
  let total = 0;
  const items: { label: string; count: number; color: string }[] = [];
  for (const val of segmentValues) {
    const count = props[`seg_${val}`] ?? 0;
    if (count <= 0) continue;
    items.push({ label: val, count, color: dimColorHex(val) });
    total += count;
  }
  items.sort((a, b) => b.count - a.count);

  let html = `<div style="font-size:12px;line-height:1.5;color:#d1d5db;min-width:120px">`;
  if (geoValue) {
    html += `<div style="font-weight:600;margin-bottom:4px;color:#f3f4f6">${geoValue}</div>`;
  }
  html += `<div style="font-weight:600;margin-bottom:2px;color:#9ca3af">${total.toLocaleString()} total</div>`;
  for (const item of items) {
    const pct = total > 0 ? ((item.count / total) * 100).toFixed(1) : "0";
    html += `<div style="display:flex;align-items:center;gap:6px">`;
    html += `<span style="width:8px;height:8px;border-radius:50%;background:${item.color};flex-shrink:0"></span>`;
    html += `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.label}</span>`;
    html += `<span style="color:#6b7280;font-variant-numeric:tabular-nums">${item.count.toLocaleString()} (${pct}%)</span>`;
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function DonutClusterMap({
  matrixData,
  geoDim,
  segmentDim,
  lngDim,
  height = 550,
}: DonutClusterMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Record<string, maplibregl.Marker>>({});
  const markersOnScreenRef = useRef<Record<string, maplibregl.Marker>>({});
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const [legendItems, setLegendItems] = useState<{ value: string; color: string }[]>([]);

  // ── Convert matrix data to GeoJSON ────────────────────────────────────

  const buildGeoJSON = useCallback((): {
    geojson: GeoJSON.FeatureCollection;
    segmentValues: string[];
  } => {
    // Collect all unique segment values
    const segmentValuesSet = new Set<string>();
    for (const row of matrixData) {
      const val = String(row[segmentDim] ?? "");
      if (val) segmentValuesSet.add(val);
    }
    const segmentValues = [...segmentValuesSet].sort();

    // Group by geo position
    const groups = new Map<
      string,
      { lng: number; lat: number; geoValue: string; counts: Map<string, number> }
    >();

    for (const row of matrixData) {
      const segVal = String(row[segmentDim] ?? "");
      const count = Number(row.count ?? 0);
      if (!segVal || count <= 0) continue;

      let lng: number | null = null;
      let lat: number | null = null;
      let geoValue = "";

      if (geoDim === "geo.country") {
        const code = String(row["geo.country"] ?? "");
        if (!code) continue;
        const centroid = getCountryCentroid(code);
        if (!centroid) continue;
        [lng, lat] = centroid;
        geoValue = code;
      } else if (geoDim === "geo.latitude" && lngDim) {
        lat = parseFloat(String(row["geo.latitude"] ?? ""));
        lng = parseFloat(String(row[lngDim] ?? ""));
        if (isNaN(lat) || isNaN(lng)) continue;
        geoValue = `${lat.toFixed(2)}, ${lng.toFixed(2)}`;
      } else if (geoDim === "geo.city") {
        // For city, we'd need lat/lng too. If available use them,
        // otherwise skip (city names alone can't be positioned).
        const cityLat = parseFloat(String(row["geo.latitude"] ?? ""));
        const cityLng = parseFloat(String(row["geo.longitude"] ?? ""));
        if (isNaN(cityLat) || isNaN(cityLng)) {
          // Fall back to country centroid if available
          const code = String(row["geo.country"] ?? "");
          if (!code) continue;
          const centroid = getCountryCentroid(code);
          if (!centroid) continue;
          [lng, lat] = centroid;
        } else {
          lng = cityLng;
          lat = cityLat;
        }
        geoValue = String(row["geo.city"] ?? "");
      } else {
        continue;
      }

      if (lng === null || lat === null) continue;

      const posKey = `${lng.toFixed(4)}_${lat.toFixed(4)}`;
      let group = groups.get(posKey);
      if (!group) {
        group = { lng, lat, geoValue, counts: new Map() };
        groups.set(posKey, group);
      }
      group.counts.set(segVal, (group.counts.get(segVal) ?? 0) + count);
    }

    // Build features: one feature per segment-value at each position
    // (MapLibre clustering will aggregate via clusterProperties)
    const features: GeoJSON.Feature[] = [];
    for (const group of groups.values()) {
      for (const [segVal, count] of group.counts) {
        features.push({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [group.lng, group.lat],
          },
          properties: {
            segmentValue: segVal,
            count,
            geoValue: group.geoValue,
          },
        });
      }
    }

    return {
      geojson: { type: "FeatureCollection", features },
      segmentValues,
    };
  }, [matrixData, geoDim, segmentDim, lngDim]);

  // ── Map lifecycle ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: DARK_STYLE,
      center: [0, 20],
      zoom: 1.5,
      attributionControl: false,
    });

    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      "bottom-right",
    );
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current = {};
      markersOnScreenRef.current = {};
    };
  }, []);

  // ── Data update ───────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const { geojson, segmentValues } = buildGeoJSON();

    // Update legend
    setLegendItems(
      segmentValues.map((v) => ({ value: v, color: dimColorHex(v) })),
    );

    // Build clusterProperties: for each segment value, sum counts
    // where segmentValue matches
    const clusterProperties: Record<string, maplibregl.ExpressionSpecification> = {};
    for (const val of segmentValues) {
      clusterProperties[`seg_${val}`] = [
        "+",
        ["case", ["==", ["get", "segmentValue"], val], ["get", "count"], 0],
      ] as unknown as maplibregl.ExpressionSpecification;
    }

    function setupSource() {
      // Remove old source/layers if they exist
      if (map!.getSource("events")) {
        if (map!.getLayer("event_circle")) map!.removeLayer("event_circle");
        if (map!.getLayer("event_label")) map!.removeLayer("event_label");
        map!.removeSource("events");
      }

      // Clear old markers
      for (const id in markersOnScreenRef.current) {
        markersOnScreenRef.current[id].remove();
      }
      markersRef.current = {};
      markersOnScreenRef.current = {};

      // Remove old popup
      if (popupRef.current) {
        popupRef.current.remove();
        popupRef.current = null;
      }

      if (geojson.features.length === 0) return;

      map!.addSource("events", {
        type: "geojson",
        data: geojson,
        cluster: true,
        clusterRadius: 80,
        clusterProperties,
      });

      // Unclustered individual points — small coloured circles
      map!.addLayer({
        id: "event_circle",
        type: "circle",
        source: "events",
        filter: ["!=", "cluster", true],
        paint: {
          "circle-color": [
            "match",
            ["get", "segmentValue"],
            // Build match pairs for each segment value
            ...segmentValues.flatMap((v) => [v, dimColorHex(v)]),
            "#6b7280", // fallback grey
          ] as unknown as maplibregl.ExpressionSpecification,
          "circle-opacity": 0.8,
          "circle-radius": 8,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#111827",
        },
      });

      // Unclustered point labels (count)
      map!.addLayer({
        id: "event_label",
        type: "symbol",
        source: "events",
        filter: ["!=", "cluster", true],
        layout: {
          "text-field": [
            "number-format",
            ["get", "count"],
            { "min-fraction-digits": 0, "max-fraction-digits": 0 },
          ],
          "text-size": 10,
        },
        paint: {
          "text-color": "#d1d5db",
        },
      });

      function updateMarkers() {
        const newMarkers: Record<string, maplibregl.Marker> = {};
        const features = map!.querySourceFeatures("events");

        for (const feature of features) {
          const props = feature.properties as Record<string, unknown>;
          if (!props?.cluster) continue;
          const id = String(props.cluster_id);
          const coords = (feature.geometry as GeoJSON.Point).coordinates as [
            number,
            number,
          ];

          let marker = markersRef.current[id];
          if (!marker) {
            // Parse cluster properties (may be stringified)
            const parsed: Record<string, number> = {};
            for (const key of Object.keys(props)) {
              if (key.startsWith("seg_")) {
                parsed[key] =
                  typeof props[key] === "string"
                    ? parseFloat(props[key] as string)
                    : Number(props[key]);
              }
            }

            const el = createDonutChart(segmentValues, parsed);

            // Tooltip on hover
            el.addEventListener("mouseenter", () => {
              if (popupRef.current) popupRef.current.remove();

              // Show tooltip immediately without geo label
              const popup = new maplibregl.Popup({
                closeButton: false,
                closeOnClick: false,
                offset: 15,
                className: "donut-popup",
              })
                .setLngLat(coords)
                .setHTML(createTooltipHTML(segmentValues, parsed))
                .addTo(map!);
              popupRef.current = popup;

              // Fetch cluster leaves to extract geo values, then update tooltip
              const source = map!.getSource("events") as maplibregl.GeoJSONSource;
              source.getClusterLeaves(Number(props.cluster_id), Infinity, 0)
                .then((leaves) => {
                  const geoVals = new Set<string>();
                  for (const leaf of leaves) {
                    const v = leaf.properties?.geoValue;
                    if (v) geoVals.add(String(v));
                  }
                  if (geoVals.size > 0 && popup.isOpen()) {
                    const sorted = [...geoVals].sort();
                    const geoLabel = sorted.length <= 5
                      ? sorted.join(", ")
                      : `${sorted.slice(0, 5).join(", ")} +${sorted.length - 5} more`;
                    popup.setHTML(createTooltipHTML(segmentValues, parsed, geoLabel));
                  }
                })
                .catch(() => { /* ignore — tooltip stays without geo label */ });
            });
            el.addEventListener("mouseleave", () => {
              if (popupRef.current) {
                popupRef.current.remove();
                popupRef.current = null;
              }
            });

            // Click to zoom in
            el.addEventListener("click", () => {
              map!.flyTo({ center: coords, zoom: map!.getZoom() + 2 });
            });

            marker = markersRef.current[id] = new maplibregl.Marker({
              element: el,
            }).setLngLat(coords);
          }

          newMarkers[id] = marker;
          if (!markersOnScreenRef.current[id]) marker.addTo(map!);
        }

        // Remove markers no longer visible
        for (const id in markersOnScreenRef.current) {
          if (!newMarkers[id]) markersOnScreenRef.current[id].remove();
        }
        markersOnScreenRef.current = newMarkers;
      }

      // Unclustered point tooltips
      map!.on("mouseenter", "event_circle", (e) => {
        map!.getCanvas().style.cursor = "pointer";
        if (e.features && e.features[0]) {
          const props = e.features[0].properties as Record<string, string>;
          const coords = (e.features[0].geometry as GeoJSON.Point)
            .coordinates as [number, number];
          const segVal = props.segmentValue ?? "";
          const count = parseInt(props.count ?? "0", 10);
          const geoValue = props.geoValue ?? "";

          if (popupRef.current) popupRef.current.remove();
          popupRef.current = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
            offset: 10,
            className: "donut-popup",
          })
            .setLngLat(coords)
            .setHTML(
              `<div style="font-size:12px;line-height:1.5;color:#d1d5db">` +
                (geoValue
                  ? `<div style="font-weight:600;color:#f3f4f6">${geoValue}</div>`
                  : "") +
                `<div style="display:flex;align-items:center;gap:6px">` +
                `<span style="width:8px;height:8px;border-radius:50%;background:${dimColorHex(segVal)};flex-shrink:0"></span>` +
                `<span>${segVal}</span>` +
                `<span style="color:#6b7280;font-variant-numeric:tabular-nums">${count.toLocaleString()}</span>` +
                `</div></div>`,
            )
            .addTo(map!);
        }
      });

      map!.on("mouseleave", "event_circle", () => {
        map!.getCanvas().style.cursor = "";
        if (popupRef.current) {
          popupRef.current.remove();
          popupRef.current = null;
        }
      });

      map!.on("render", () => {
        if (!map!.isSourceLoaded("events")) return;
        updateMarkers();
      });
    }

    if (map.isStyleLoaded()) {
      setupSource();
    } else {
      map.on("load", setupSource);
    }

    return () => {
      // Cleanup on data change: remove source/layers/markers
      if (map.getSource("events")) {
        if (map.getLayer("event_circle")) map.removeLayer("event_circle");
        if (map.getLayer("event_label")) map.removeLayer("event_label");
        map.removeSource("events");
      }
      for (const id in markersOnScreenRef.current) {
        markersOnScreenRef.current[id].remove();
      }
      markersRef.current = {};
      markersOnScreenRef.current = {};
      if (popupRef.current) {
        popupRef.current.remove();
        popupRef.current = null;
      }
    };
  }, [buildGeoJSON]);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="relative">
      <div
        ref={containerRef}
        style={{ height, width: "100%", borderRadius: 8, overflow: "hidden" }}
      />

      {/* Legend */}
      {legendItems.length > 0 && (
        <div className="absolute top-2 left-2 bg-gray-900/90 border border-gray-700 rounded-lg px-3 py-2 max-h-48 overflow-y-auto">
          <p className="text-[10px] text-gray-500 mb-1 uppercase tracking-wider">
            {segmentDim}
          </p>
          {legendItems.map((item) => (
            <div
              key={item.value}
              className="flex items-center gap-2 text-xs text-gray-300 py-0.5"
            >
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: item.color }}
              />
              <span className="truncate max-w-[140px] font-mono">
                {item.value}
              </span>
            </div>
          ))}
        </div>
      )}

      {matrixData.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm text-gray-500">No data to display on map</span>
        </div>
      )}
    </div>
  );
}

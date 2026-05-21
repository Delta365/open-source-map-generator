// Map Generator — UI thread (Figma plugin iframe).
//
// Renders an interactive MapLibre map (CARTO + Esri Satellite + OpenTopoMap),
// supports user-placed pins, view controls, multiple frame sizes, and
// configurable export (pixel ratio + PNG/JPEG). On Export the plugin spawns
// an off-screen high-resolution map, captures the canvas, and ships the
// bytes to the Figma sandbox which materialises a frame.

import maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// =============================================================================
// Types & config
// =============================================================================

interface StyleDef {
  id: string;
  label: string;
  spec: string | StyleSpecification;
}

interface SizePreset {
  id: string;
  label: string;
  w: number;
  h: number;
}

interface Pin {
  id: string;
  lng: number;
  lat: number;
  label: string;
  color: string;
}

const CARTO_GLYPHS =
  "https://basemaps.cartocdn.com/gl/voyager-gl-style/glyphs/{fontstack}/{range}.pbf";

const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  glyphs: CARTO_GLYPHS,
  sources: {
    esri: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution:
        "Imagery © Esri, Maxar, Earthstar Geographics, USDA FSA, USGS",
      maxzoom: 19,
    },
  },
  layers: [{ id: "esri", type: "raster", source: "esri" }],
};

const TERRAIN_STYLE: StyleSpecification = {
  version: 8,
  glyphs: CARTO_GLYPHS,
  sources: {
    otm: {
      type: "raster",
      tiles: [
        "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
        "https://b.tile.opentopomap.org/{z}/{x}/{y}.png",
        "https://c.tile.opentopomap.org/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution:
        "© OpenStreetMap contributors, SRTM | Map style © OpenTopoMap (CC-BY-SA)",
      maxzoom: 17,
    },
  },
  layers: [{ id: "otm", type: "raster", source: "otm" }],
};

const STYLES: StyleDef[] = [
  {
    id: "voyager",
    label: "Voyager",
    spec: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
  },
  {
    id: "voyager-nolabels",
    label: "Voyager (no labels)",
    spec: "https://basemaps.cartocdn.com/gl/voyager-nolabels-gl-style/style.json",
  },
  {
    id: "positron",
    label: "Light",
    spec: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  },
  {
    id: "positron-nolabels",
    label: "Light (no labels)",
    spec: "https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json",
  },
  {
    id: "dark-matter",
    label: "Dark",
    spec: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  },
  {
    id: "dark-matter-nolabels",
    label: "Dark (no labels)",
    spec: "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json",
  },
  { id: "satellite", label: "Satellite", spec: SATELLITE_STYLE },
  { id: "terrain", label: "Terrain", spec: TERRAIN_STYLE },
];

const SIZE_PRESETS: SizePreset[] = [
  { id: "1920x1080", label: "1920 × 1080 (Full HD)", w: 1920, h: 1080 },
  { id: "1080x1920", label: "1080 × 1920 (Vertical)", w: 1080, h: 1920 },
  { id: "1080x1080", label: "1080 × 1080 (Square)", w: 1080, h: 1080 },
  { id: "1440x1080", label: "1440 × 1080 (4:3)", w: 1440, h: 1080 },
  { id: "1280x720", label: "1280 × 720 (HD)", w: 1280, h: 720 },
  { id: "2560x1440", label: "2560 × 1440 (2K)", w: 2560, h: 1440 },
  { id: "3840x2160", label: "3840 × 2160 (4K)", w: 3840, h: 2160 },
  { id: "custom", label: "Custom…", w: 1920, h: 1080 },
];

const PIN_COLORS = [
  "#e53935",
  "#1e88e5",
  "#43a047",
  "#fb8c00",
  "#8e24aa",
  "#00897b",
  "#fdd835",
  "#6d4c41",
];

const ROUTE_COLORS = [
  "#0d99ff",
  "#9c27b0",
  "#ff9800",
  "#009688",
  "#795548",
  "#3f51b5",
];

const EXPORT_TIMEOUT_MS = 60_000;
const MAX_RECENT = 5;
const MAX_PIXEL_DIM = 8192;

const PINS_SOURCE = "user-pins";
const PINS_CIRCLE_LAYER = "user-pins-circle";
const PINS_LABEL_LAYER = "user-pins-label";

const ROUTES_SOURCE = "user-routes";
const ROUTES_LINE_LAYER = "user-routes-line";

const GRATICULE_SOURCE = "user-graticule";
const GRATICULE_LAYER = "user-graticule-line";
const GRATICULE_SPACING_DEG = 10;

// OpenRouteService directions endpoint base. The mode (driving-car,
// cycling-regular, foot-walking) is appended at call time. Requires a free
// API key supplied by each user (set in the Routes tab). HeiGIT-operated.
const ORS_DIRECTIONS_BASE =
  "https://api.openrouteservice.org/v2/directions";

// =============================================================================
// DOM refs
// =============================================================================

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el as T;
};

const styleSelect = $<HTMLSelectElement>("#style-select");
const searchInput = $<HTMLInputElement>("#search");
const searchBtn = $<HTMLButtonElement>("#search-btn");
const recentPop = $<HTMLDivElement>("#recent-pop");
const mapWrap = $<HTMLDivElement>(".map-wrap");
const mapFrame = $<HTMLDivElement>("#map-frame");
const resetViewBtn = $<HTMLButtonElement>("#reset-view");
const ratioBadge = $<HTMLDivElement>("#ratio-badge");
const statusEl = $<HTMLDivElement>("#status");
const bearingInput = $<HTMLInputElement>("#bearing");
const pitchInput = $<HTMLInputElement>("#pitch");
const zoomInput = $<HTMLInputElement>("#zoom");
const resetBearingBtn = $<HTMLButtonElement>("#reset-bearing");
const pinChips = $<HTMLDivElement>("#pin-chips");
const pinCountEl = $<HTMLSpanElement>("#pin-count");
const pinEmpty = $<HTMLParagraphElement>("#pin-empty");
const addPinBtn = $<HTMLButtonElement>("#add-pin");
const clearPinsBtn = $<HTMLButtonElement>("#clear-pins");
const sizePresetSel = $<HTMLSelectElement>("#size-preset");
const sizeWInput = $<HTMLInputElement>("#size-w");
const sizeHInput = $<HTMLInputElement>("#size-h");
const formatSel = $<HTMLSelectElement>("#format");
const pixelRatioSel = $<HTMLSelectElement>("#pixel-ratio");
const exportBtn = $<HTMLButtonElement>("#export");
const aboutBtn = $<HTMLButtonElement>("#about-btn");
const aboutModal = $<HTMLDivElement>("#about-modal");
const aboutClose = $<HTMLButtonElement>("#about-close");
const sidePanel = $<HTMLElement>("#side-panel");
const panelToggle = $<HTMLButtonElement>("#panel-toggle");
const firstRunHint = $<HTMLDivElement>("#first-run-hint");
const firstRunDismiss = $<HTMLButtonElement>("#first-run-dismiss");

// =============================================================================
// State
// =============================================================================

let currentStyleId = "voyager";
let currentSize: { w: number; h: number } = { w: 1920, h: 1080 };
let pinMode = false;
const pins: Pin[] = [];
let pinSeq = 1;
const recentSearches: string[] = [];

// =============================================================================
// Helpers
// =============================================================================

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function getStyleSpec(id: string): string | StyleSpecification {
  const def = STYLES.find((s) => s.id === id);
  if (!def) throw new Error(`Unknown style: ${id}`);
  // Deep-copy inline style objects so MapLibre doesn't mutate our config when
  // re-using the same spec for the off-screen export map.
  return typeof def.spec === "string"
    ? def.spec
    : (JSON.parse(JSON.stringify(def.spec)) as StyleSpecification);
}

// =============================================================================
// Populate selects
// =============================================================================

function populateSelects(): void {
  styleSelect.innerHTML = STYLES.map(
    (s) => `<option value="${s.id}">${escapeHtml(s.label)}</option>`,
  ).join("");
  styleSelect.value = currentStyleId;

  sizePresetSel.innerHTML = SIZE_PRESETS.map(
    (s) => `<option value="${s.id}">${escapeHtml(s.label)}</option>`,
  ).join("");
  sizePresetSel.value = "1920x1080";
}

// =============================================================================
// Map
// =============================================================================

const map = new maplibregl.Map({
  container: "map",
  style: getStyleSpec(currentStyleId) as StyleSpecification,
  center: [0, 25],
  zoom: 1.4,
  bearing: 0,
  pitch: 0,
  attributionControl: false,
  hash: false,
  fadeDuration: 200,
});

map.addControl(
  new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }),
  "top-right",
);
map.addControl(
  new maplibregl.AttributionControl({ compact: true }),
  // Bottom-left so the attribution stays visible when the side panel slides
  // over the right edge of the map. OSM/CARTO TOS require it to be reachable.
  "bottom-left",
);

// Re-add overlay layers whenever the style finishes loading (setStyle wipes
// them). Routes go on first so pins draw on top of route lines.
// Also enable globe projection — MapLibre 5 auto-flattens to Mercator at
// zoom > ~12, so city-level work is unaffected while world-level views
// render as a sphere.
map.on("style.load", () => {
  map.setProjection({ type: "globe" });
  // Order matters: graticule first (lowest), then routes, then pins on top.
  if (graticuleVisible) ensureGraticuleLayers(map);
  ensureRoutesLayers(map);
  ensurePinsLayers(map);
});

// Keep view inputs in sync with map state.
map.on("moveend", syncViewInputs);
map.on("rotateend", syncViewInputs);
map.on("pitchend", syncViewInputs);
map.on("zoomend", syncViewInputs);

map.on("click", (e) => {
  if (pinMode) {
    addPin(e.lngLat.lng, e.lngLat.lat);
  }
});

// =============================================================================
// Style switching
// =============================================================================

// One-off "share-alike" notice the first time the user picks Terrain in a
// session — see About modal for the full explanation.
let terrainNoticeShown = false;

styleSelect.addEventListener("change", () => {
  const id = styleSelect.value;
  if (id === currentStyleId) return;
  currentStyleId = id;
  map.setStyle(getStyleSpec(id) as StyleSpecification);
  if (id === "terrain" && !terrainNoticeShown) {
    terrainNoticeShown = true;
    showStatus(
      "Terrain uses OpenTopoMap (CC BY-SA 3.0). Exports must credit OpenTopoMap & OSM. See About for details.",
      false,
      9000,
    );
  }
});

// =============================================================================
// Pins
// =============================================================================

function pinsGeoJSON() {
  return {
    type: "FeatureCollection" as const,
    features: pins.map((p) => ({
      type: "Feature" as const,
      properties: { id: p.id, label: p.label, color: p.color },
      geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
    })),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensurePinsLayers(target: any): void {
  const data = pinsGeoJSON();
  if (!target.getSource(PINS_SOURCE)) {
    target.addSource(PINS_SOURCE, { type: "geojson", data });
  } else {
    target.getSource(PINS_SOURCE).setData(data);
  }
  if (!target.getLayer(PINS_CIRCLE_LAYER)) {
    target.addLayer({
      id: PINS_CIRCLE_LAYER,
      type: "circle",
      source: PINS_SOURCE,
      paint: {
        "circle-radius": 8,
        "circle-color": ["get", "color"],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
        // Render the circle flat on the ground plane so it foreshortens
        // with the camera's pitch — when the user tilts the map, the pin
        // becomes an ellipse instead of staying a face-on disc.
        "circle-pitch-alignment": "map",
      },
    });
  }
  if (!target.getLayer(PINS_LABEL_LAYER)) {
    try {
      target.addLayer({
        id: PINS_LABEL_LAYER,
        type: "symbol",
        source: PINS_SOURCE,
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Open Sans Regular"],
          "text-size": 12,
          "text-offset": [0, 1.2],
          "text-anchor": "top",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#1e1e1e",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
          "text-halo-blur": 0.4,
        },
      });
    } catch {
      // Some styles may not have the requested glyphs; skip labels gracefully.
    }
  }
}

function refreshPinsSource(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const src = map.getSource(PINS_SOURCE) as any;
  if (src) src.setData(pinsGeoJSON());
}

function addPin(lng: number, lat: number): void {
  const id = `pin-${Date.now()}-${pinSeq++}`;
  const color = PIN_COLORS[pins.length % PIN_COLORS.length];
  const pin: Pin = {
    id,
    lng,
    lat,
    label: `Pin ${pins.length + 1}`,
    color,
  };
  pins.push(pin);
  renderPinChips();
  refreshPinsSource();
  showStatus(`Added ${pin.label}`);
}

function removePin(id: string): void {
  const i = pins.findIndex((p) => p.id === id);
  if (i === -1) return;
  pins.splice(i, 1);
  renderPinChips();
  refreshPinsSource();
}

function renamePin(id: string, name: string): void {
  const p = pins.find((pp) => pp.id === id);
  if (!p) return;
  const trimmed = name.trim();
  if (trimmed) p.label = trimmed;
  refreshPinsSource();
}

function clearPins(): void {
  pins.length = 0;
  renderPinChips();
  refreshPinsSource();
}

function renderPinChips(): void {
  const n = pins.length;
  pinCountEl.textContent =
    n === 0 ? "No pins" : `${n} pin${n === 1 ? "" : "s"}`;
  clearPinsBtn.disabled = n === 0;
  pinEmpty.style.display = n === 0 ? "block" : "none";
  pinChips.innerHTML = "";

  pins.forEach((p) => {
    const row = document.createElement("div");
    row.className = "pin-item";
    row.dataset.pinId = p.id;
    row.title = "Double-click to fly to this pin";
    row.innerHTML = `
      <span class="dot" style="background:${p.color}"></span>
      <div class="pin-meta">
        <span class="name" contenteditable="true" spellcheck="false">${escapeHtml(p.label)}</span>
        <span class="coords">${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</span>
      </div>
      <button class="remove" type="button" aria-label="Remove pin" title="Remove">×</button>
    `;

    const nameEl = row.querySelector(".name") as HTMLSpanElement;
    nameEl.addEventListener("blur", () => {
      renamePin(p.id, nameEl.textContent ?? "");
    });
    nameEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        nameEl.blur();
      }
    });

    const dotEl = row.querySelector(".dot") as HTMLSpanElement;
    dotEl.title = "Click to change color";
    dotEl.addEventListener("click", (e) => {
      e.stopPropagation();
      openPinColorPicker(p.id, p.color);
    });

    row.addEventListener("dblclick", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".name") || t.closest(".remove") || t.closest(".dot")) return;
      map.flyTo({
        center: [p.lng, p.lat],
        zoom: Math.max(map.getZoom(), 13),
        duration: 600,
      });
    });

    row.querySelector(".remove")!.addEventListener("click", () => {
      removePin(p.id);
    });

    pinChips.appendChild(row);
  });
}

// ---- Per-pin colour picker (native <input type="color">) -----------------
//
// One shared hidden input is reused for every pin. Live preview updates the
// map on every `input` event (as the user moves through the colour wheel);
// `change` fires when the picker closes and is when we re-render the chip
// list so the swatch in the row reflects the final pick.

const pinColorPicker = $<HTMLInputElement>("#pin-color-picker");
let activeColorPinId: string | null = null;

function openPinColorPicker(pinId: string, currentColor: string): void {
  activeColorPinId = pinId;
  pinColorPicker.value = currentColor;
  pinColorPicker.click();
}

pinColorPicker.addEventListener("input", () => {
  if (!activeColorPinId) return;
  const pin = pins.find((pp) => pp.id === activeColorPinId);
  if (!pin) return;
  pin.color = pinColorPicker.value;
  refreshPinsSource();
  // Update the dot's background in the existing row without a full re-render
  // so live preview doesn't blow away the user's cursor / focus.
  const liveDot = document.querySelector<HTMLSpanElement>(
    `.pin-item[data-pin-id="${activeColorPinId}"] .dot`,
  );
  if (liveDot) liveDot.style.background = pin.color;
});

pinColorPicker.addEventListener("change", () => {
  activeColorPinId = null;
});

function setPinMode(on: boolean): void {
  pinMode = on;
  addPinBtn.classList.toggle("active", on);
  document.body.classList.toggle("pin-mode", on);
  if (on) showStatus("Click on the map to drop a pin. Click the button again to stop.");
}

addPinBtn.addEventListener("click", () => setPinMode(!pinMode));
clearPinsBtn.addEventListener("click", clearPins);

// =============================================================================
// View controls (bearing / pitch / zoom)
// =============================================================================

function syncViewInputs(): void {
  bearingInput.value = String(Math.round(map.getBearing()));
  pitchInput.value = String(Math.round(map.getPitch()));
  zoomInput.value = map.getZoom().toFixed(2);
}

function applyViewFromInputs(): void {
  const bearing = clamp(parseFloat(bearingInput.value) || 0, -180, 180);
  const pitch = clamp(parseFloat(pitchInput.value) || 0, 0, 60);
  const zoom = clamp(parseFloat(zoomInput.value) || 0, 0, 22);
  bearingInput.value = String(Math.round(bearing));
  pitchInput.value = String(Math.round(pitch));
  zoomInput.value = zoom.toFixed(2);
  map.easeTo({ bearing, pitch, zoom, duration: 250 });
}

[bearingInput, pitchInput, zoomInput].forEach((input) => {
  input.addEventListener("change", applyViewFromInputs);
});

// Stepper +/− buttons next to bearing / pitch / zoom inputs. They simply
// nudge the underlying input by `data-step` and dispatch `change` so the
// existing applyViewFromInputs flow runs.
document.querySelectorAll<HTMLButtonElement>(".stepper-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = btn.dataset.target;
    const stepDir = parseFloat(btn.dataset.step ?? "0");
    if (!targetId || !Number.isFinite(stepDir) || stepDir === 0) return;
    const input = document.getElementById(targetId) as HTMLInputElement | null;
    if (!input) return;
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    const current = parseFloat(input.value) || 0;
    let next = current + stepDir;
    if (Number.isFinite(min)) next = Math.max(min, next);
    if (Number.isFinite(max)) next = Math.min(max, next);
    input.value = String(next);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
});

resetViewBtn.addEventListener("click", () => {
  map.easeTo({ bearing: 0, pitch: 0, duration: 400 });
});
resetBearingBtn.addEventListener("click", () => {
  map.easeTo({ bearing: 0, pitch: 0, duration: 400 });
});

// =============================================================================
// Size / aspect ratio
// =============================================================================

function applySize(w: number, h: number, source: "preset" | "input" = "preset"): void {
  currentSize = { w, h };
  ratioBadge.textContent = `${w} × ${h}`;
  if (source === "preset") {
    sizeWInput.value = String(w);
    sizeHInput.value = String(h);
  }
  fitFrame();
}

function findMatchingPreset(w: number, h: number): string | null {
  const m = SIZE_PRESETS.find(
    (p) => p.id !== "custom" && p.w === w && p.h === h,
  );
  return m ? m.id : null;
}

sizePresetSel.addEventListener("change", () => {
  const id = sizePresetSel.value;
  const preset = SIZE_PRESETS.find((p) => p.id === id);
  if (!preset) return;
  if (id !== "custom") {
    applySize(preset.w, preset.h);
  }
});

[sizeWInput, sizeHInput].forEach((input) => {
  input.addEventListener("change", () => {
    const w = clamp(
      Math.round(parseFloat(sizeWInput.value) || 0),
      64,
      MAX_PIXEL_DIM,
    );
    const h = clamp(
      Math.round(parseFloat(sizeHInput.value) || 0),
      64,
      MAX_PIXEL_DIM,
    );
    sizeWInput.value = String(w);
    sizeHInput.value = String(h);
    sizePresetSel.value = findMatchingPreset(w, h) ?? "custom";
    applySize(w, h, "input");
  });
});

// Fits map-frame to the largest rectangle of the selected aspect ratio that
// still fits inside .map-wrap. Called on resize and on size changes.
function fitFrame(): void {
  const w = mapWrap.clientWidth;
  const h = mapWrap.clientHeight;
  if (w === 0 || h === 0) return;
  const target = currentSize.w / currentSize.h;
  let fw: number;
  let fh: number;
  if (w / h > target) {
    fh = h;
    fw = h * target;
  } else {
    fw = w;
    fh = w / target;
  }
  mapFrame.style.width = `${Math.floor(fw)}px`;
  mapFrame.style.height = `${Math.floor(fh)}px`;
  if (map) map.resize();
}

// =============================================================================
// Search (Nominatim) — live suggestions while typing + recent search history
// (persisted via plugin clientStorage). The dropdown shows live suggestions
// when the user is typing and recent searches when the input is empty.
// =============================================================================

const LATLNG_RE = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
const SUGGEST_DEBOUNCE_MS = 350;
const SUGGEST_MIN_LEN = 2;
const SUGGEST_LIMIT = 6;

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  type?: string;
  boundingbox?: [string, string, string, string];
}

type DropdownMode = "closed" | "recent" | "suggestions";

let dropdownMode: DropdownMode = "closed";
let suggestionResults: NominatimResult[] = [];
let highlightIdx = -1;
let suggestionTimer: number | undefined;
let suggestionAbort: AbortController | null = null;

function flyToResult(r: NominatimResult): void {
  if (r.boundingbox) {
    const [s, n, w, e] = r.boundingbox.map(parseFloat);
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 24, duration: 800, maxZoom: 14 },
    );
  } else {
    map.flyTo({
      center: [parseFloat(r.lon), parseFloat(r.lat)],
      zoom: 12,
      duration: 800,
    });
  }
  showStatus(`Centred on ${r.display_name}`);
}

async function search(query: string): Promise<void> {
  const q = query.trim();
  if (!q) return;

  const m = q.match(LATLNG_RE);
  if (m) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      map.flyTo({ center: [lng, lat], zoom: 12, duration: 800 });
      showStatus(`Centred at ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
      pushRecent(q);
      return;
    }
  }

  try {
    showStatus("Searching…");
    searchBtn.disabled = true;
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
      encodeURIComponent(q);
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
    const data = (await res.json()) as NominatimResult[];
    if (!Array.isArray(data) || data.length === 0) {
      showStatus("No results.", true);
      return;
    }
    flyToResult(data[0]);
    pushRecent(q);
  } catch (err) {
    showStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    searchBtn.disabled = false;
  }
}

async function fetchSuggestions(q: string): Promise<void> {
  if (suggestionAbort) suggestionAbort.abort();
  suggestionAbort = new AbortController();
  try {
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=" +
      SUGGEST_LIMIT +
      "&q=" +
      encodeURIComponent(q);
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: suggestionAbort.signal,
    });
    if (!res.ok) return;
    const data = (await res.json()) as NominatimResult[];
    if (!Array.isArray(data) || data.length === 0) {
      closeDropdown();
      return;
    }
    suggestionResults = data;
    highlightIdx = -1;
    renderSuggestions();
  } catch (e) {
    // AbortError = the user kept typing, ignore.
    if ((e as { name?: string })?.name === "AbortError") return;
    // Stay quiet on transient typing-time errors.
  }
}

function debouncedSuggest(value: string): void {
  if (suggestionTimer != null) window.clearTimeout(suggestionTimer);
  if (suggestionAbort) suggestionAbort.abort();
  const q = value.trim();
  if (!q) {
    if (recentSearches.length) renderRecent();
    else closeDropdown();
    return;
  }
  if (LATLNG_RE.test(q) || q.length < SUGGEST_MIN_LEN) {
    closeDropdown();
    return;
  }
  suggestionTimer = window.setTimeout(
    () => void fetchSuggestions(q),
    SUGGEST_DEBOUNCE_MS,
  );
}

function pushRecent(q: string): void {
  const idx = recentSearches.indexOf(q);
  if (idx !== -1) recentSearches.splice(idx, 1);
  recentSearches.unshift(q);
  if (recentSearches.length > MAX_RECENT) {
    recentSearches.length = MAX_RECENT;
  }
  saveRecent();
}

function renderRecent(): void {
  if (!recentSearches.length) {
    closeDropdown();
    return;
  }
  recentPop.innerHTML = "";
  const header = document.createElement("div");
  header.className = "dropdown-header";
  header.textContent = "Recent";
  recentPop.appendChild(header);
  recentSearches.forEach((q) => {
    const item = document.createElement("div");
    item.className = "recent-item";
    item.innerHTML =
      `<span class="leading">↻</span><span>${escapeHtml(q)}</span>`;
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      searchInput.value = q;
      closeDropdown();
      void search(q);
    });
    recentPop.appendChild(item);
  });
  const clear = document.createElement("div");
  clear.className = "recent-clear";
  clear.textContent = "Clear recent";
  clear.addEventListener("mousedown", (e) => {
    e.preventDefault();
    recentSearches.length = 0;
    saveRecent();
    closeDropdown();
  });
  recentPop.appendChild(clear);
  dropdownMode = "recent";
  recentPop.classList.add("open");
}

function renderSuggestions(): void {
  recentPop.innerHTML = "";
  suggestionResults.forEach((r, i) => {
    const item = document.createElement("div");
    item.className = "recent-item suggestion-item";
    if (i === highlightIdx) item.classList.add("highlighted");
    item.dataset.idx = String(i);
    item.innerHTML =
      `<span class="leading">›</span>` +
      `<span class="suggest-name">${escapeHtml(r.display_name)}</span>`;
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pickSuggestion(i);
    });
    item.addEventListener("mouseover", () => {
      highlightIdx = i;
      updateHighlight();
    });
    recentPop.appendChild(item);
  });
  dropdownMode = "suggestions";
  recentPop.classList.add("open");
}

function updateHighlight(): void {
  const items =
    recentPop.querySelectorAll<HTMLDivElement>(".suggestion-item");
  items.forEach((el, i) => {
    el.classList.toggle("highlighted", i === highlightIdx);
  });
}

function pickSuggestion(i: number): void {
  const r = suggestionResults[i];
  if (!r) return;
  searchInput.value = r.display_name;
  closeDropdown();
  flyToResult(r);
  pushRecent(r.display_name);
}

function closeDropdown(): void {
  recentPop.classList.remove("open");
  dropdownMode = "closed";
  highlightIdx = -1;
}

function saveRecent(): void {
  parent.postMessage(
    {
      pluginMessage: { type: "save-recent", recent: recentSearches.slice() },
    },
    "*",
  );
}

searchBtn.addEventListener("click", () => {
  void search(searchInput.value);
  closeDropdown();
});

searchInput.addEventListener("input", () => {
  debouncedSuggest(searchInput.value);
});

searchInput.addEventListener("focus", () => {
  debouncedSuggest(searchInput.value);
});

searchInput.addEventListener("blur", () => {
  // Delay so a click on a dropdown item runs first.
  setTimeout(closeDropdown, 150);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (dropdownMode === "suggestions" && highlightIdx >= 0) {
      pickSuggestion(highlightIdx);
    } else {
      void search(searchInput.value);
      closeDropdown();
    }
    return;
  }
  if (e.key === "Escape") {
    if (dropdownMode !== "closed") {
      e.preventDefault();
      closeDropdown();
    }
    return;
  }
  if (
    (e.key === "ArrowDown" || e.key === "ArrowUp") &&
    dropdownMode === "suggestions"
  ) {
    e.preventDefault();
    const len = suggestionResults.length;
    if (len === 0) return;
    if (e.key === "ArrowDown") {
      highlightIdx = highlightIdx < len - 1 ? highlightIdx + 1 : 0;
    } else {
      highlightIdx = highlightIdx > 0 ? highlightIdx - 1 : len - 1;
    }
    updateHighlight();
  }
});

// =============================================================================
// Status overlay
// =============================================================================

let statusTimer: number | undefined;
function showStatus(text: string, isError = false, durationMs?: number): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
  statusEl.classList.add("show");
  if (statusTimer != null) window.clearTimeout(statusTimer);
  const ms = durationMs ?? (isError ? 5000 : 3500);
  statusTimer = window.setTimeout(
    () => statusEl.classList.remove("show"),
    ms,
  );
}

// =============================================================================
// Export
// =============================================================================

interface RenderParams {
  styleId: string;
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  width: number;
  height: number;
  pixelRatio: number;
  format: "png" | "jpeg";
  quality: number;
}

// Sent to the plugin alongside the basemap bytes so it can build native
// Figma ellipses + text for each pin.
interface ExportPin {
  x: number;
  y: number;
  label: string;
  color: string;
}

// Sent to the plugin so it can build native Figma vector polylines for
// each route.
interface ExportRoute {
  name: string;
  color: string;
  type: "roads" | "arc";
  points: { x: number; y: number }[];
}

// Each visible segment of a graticule line, projected to screen pixels.
// One graticule line may produce multiple ExportGridLines if it crosses
// behind the globe (the back half is dropped).
interface ExportGridLine {
  name: string;
  points: { x: number; y: number }[];
}

interface ExportData {
  bytes: Uint8Array;
  pins: ExportPin[];
  routes: ExportRoute[];
  gridLines: ExportGridLine[];
  // Counts of overlays we had to drop because they fell behind the camera in
  // a 3D-pitched view (project() returns nonsense for those points). Surfaced
  // as a status message after export so the user knows to reduce the pitch.
  skippedPins: number;
  skippedRoutes: number;
}

function formatGridLineName(kind: "meridian" | "parallel", value: number): string {
  if (kind === "parallel") {
    if (value === 0) return "Equator";
    return `${Math.abs(value)}°${value > 0 ? "N" : "S"}`;
  }
  if (value === 0) return "Prime Meridian";
  if (value === 180 || value === -180) return "180° (Antimeridian)";
  return `${Math.abs(value)}°${value > 0 ? "E" : "W"}`;
}

// Project a lng/lat to screen pixels, returning null if the projection is
// bogus. In 3D-pitched views, MapLibre will happily project points that are
// behind the camera to nonsensical screen coordinates — those would land
// pins/routes in the wrong place in the Figma export. We round-trip through
// unproject(): if the original lng/lat doesn't survive the trip (within a
// generous ~10 m tolerance, accounting for antimeridian wrap), the point is
// behind the camera or otherwise unrepresentable in this view, and we drop it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeProject(m: any, lng: number, lat: number): { x: number; y: number } | null {
  const px = m.project([lng, lat]);
  if (!Number.isFinite(px.x) || !Number.isFinite(px.y)) return null;
  const back = m.unproject([px.x, px.y]);
  let dLng = Math.abs(back.lng - lng) % 360;
  if (dLng > 180) dLng = 360 - dLng;
  const dLat = Math.abs(back.lat - lat);
  if (dLng > 1e-3 || dLat > 1e-3) return null;
  return { x: px.x, y: px.y };
}

function renderHighRes(p: RenderParams): Promise<ExportData> {
  return new Promise((resolve, reject) => {
    const container = document.createElement("div");
    container.style.cssText =
      `position:absolute;left:-99999px;top:0;width:${p.width}px;height:${p.height}px;`;
    document.body.appendChild(container);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let exportMap: any = null;
    let timeoutId: number | undefined;
    let settled = false;

    const cleanup = () => {
      if (timeoutId != null) window.clearTimeout(timeoutId);
      try {
        exportMap?.remove();
      } catch {
        /* ignore */
      }
      try {
        container.remove();
      } catch {
        /* ignore */
      }
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const succeed = (data: ExportData) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data);
    };

    try {
      exportMap = new maplibregl.Map({
        container,
        style: getStyleSpec(p.styleId) as StyleSpecification,
        center: p.center,
        zoom: p.zoom,
        bearing: p.bearing,
        pitch: p.pitch,
        pixelRatio: p.pixelRatio,
        attributionControl: false,
        interactive: false,
        // v5 nests this under canvasContextAttributes — required so we can
        // read pixels back from the WebGL context with toBlob().
        canvasContextAttributes: { preserveDrawingBuffer: true },
        fadeDuration: 0,
      });

      // Match the preview's projection (globe, auto-flattens to Mercator at
      // zoom > ~12). Must be set after style.load.
      //
      // Two paths from here:
      //   exportAsLayers=true  — basemap only on the export map; pins,
      //     routes, and grid are projected later and rebuilt as native
      //     Figma layers by the plugin.
      //   exportAsLayers=false — add the overlay MapLibre layers so pins,
      //     routes, and grid get rasterised into the basemap PNG. We then
      //     ship empty overlay arrays so the plugin's simple-single-fill
      //     path kicks in.
      exportMap.on("style.load", () => {
        exportMap.setProjection({ type: "globe" });
        if (!exportAsLayers) {
          if (graticuleVisible) ensureGraticuleLayers(exportMap);
          ensureRoutesLayers(exportMap);
          ensurePinsLayers(exportMap);
        }
      });

      timeoutId = window.setTimeout(
        () =>
          fail(
            new Error(`Render timed out after ${EXPORT_TIMEOUT_MS / 1000}s`),
          ),
        EXPORT_TIMEOUT_MS,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exportMap.on("error", (e: any) => {
        // tile fetch errors are usually non-fatal; only the timeout aborts.
        // eslint-disable-next-line no-console
        console.warn("[map-export]", e?.error ?? e);
      });

      exportMap.once("idle", () => {
        try {
          // Per-overlay vector data is only built when the user opted into
          // layered export. Otherwise the overlays are already part of the
          // rasterised PNG (added to the export map in the style.load
          // handler above), and we ship empty arrays.
          let skippedPins = 0;
          let skippedRoutes = 0;
          const exportPins: ExportPin[] = [];
          const exportRoutes: ExportRoute[] = [];
          const exportGridLines: ExportGridLine[] = [];

          if (exportAsLayers) {
            // Project lng/lat → screen pixels in the export map's CSS-pixel
            // coordinate space (which equals the Figma frame's pixel space).
            // safeProject filters out points whose projection is bogus —
            // the common cause is 3D pitch placing the point behind the
            // camera, or the far side of the globe at world view.
            for (const pin of pins) {
              const px = safeProject(exportMap, pin.lng, pin.lat);
              if (!px) {
                skippedPins++;
                continue;
              }
              exportPins.push({
                x: px.x,
                y: px.y,
                label: pin.label,
                color: pin.color,
              });
            }

            for (const r of routes) {
              const points: { x: number; y: number }[] = [];
              let routeOk = true;
              for (const c of r.coordinates) {
                const px = safeProject(exportMap, c[0], c[1]);
                if (!px) {
                  routeOk = false;
                  break;
                }
                points.push(px);
              }
              if (!routeOk || points.length < 2) {
                skippedRoutes++;
                continue;
              }
              exportRoutes.push({
                name: routeDisplayName(r),
                color: r.color,
                type: r.type,
                points,
              });
            }

            // Graticule lines — each one is split into visible sub-segments
            // wherever it crosses behind the globe; behind-camera vertices
            // fail safeProject's round-trip check and act as natural breaks.
            if (graticuleVisible) {
              for (const feature of graticuleData.features) {
                const name = formatGridLineName(
                  feature.properties.kind,
                  feature.properties.value,
                );
                let segment: { x: number; y: number }[] = [];
                for (const c of feature.geometry.coordinates) {
                  const px = safeProject(exportMap, c[0], c[1]);
                  if (px) {
                    segment.push(px);
                  } else if (segment.length > 0) {
                    if (segment.length >= 2) {
                      exportGridLines.push({ name, points: segment });
                    }
                    segment = [];
                  }
                }
                if (segment.length >= 2) {
                  exportGridLines.push({ name, points: segment });
                }
              }
            }
          }

          const canvas = exportMap.getCanvas() as HTMLCanvasElement;
          const mime = p.format === "jpeg" ? "image/jpeg" : "image/png";
          canvas.toBlob(
            (blob) => {
              if (!blob) {
                fail(new Error("Canvas → Blob failed."));
                return;
              }
              blob
                .arrayBuffer()
                .then((buf) =>
                  succeed({
                    bytes: new Uint8Array(buf),
                    pins: exportPins,
                    routes: exportRoutes,
                    gridLines: exportGridLines,
                    skippedPins,
                    skippedRoutes,
                  }),
                )
                .catch(fail);
            },
            mime,
            p.format === "jpeg" ? p.quality : undefined,
          );
        } catch (e) {
          fail(e);
        }
      });
    } catch (e) {
      fail(e);
    }
  });
}

async function doExport(): Promise<void> {
  if (exportBtn.disabled) return;
  const w = currentSize.w;
  const h = currentSize.h;
  const px = parseInt(pixelRatioSel.value, 10) || 2;
  const format = (formatSel.value as "png" | "jpeg") || "png";

  // Guard against absurd allocations: w*h*px^2 must fit in a canvas.
  const renderW = w * px;
  const renderH = h * px;
  if (renderW > MAX_PIXEL_DIM || renderH > MAX_PIXEL_DIM) {
    showStatus(
      `Render size ${renderW}×${renderH}px exceeds limit. Reduce frame size or pixel ratio.`,
      true,
    );
    return;
  }

  exportBtn.disabled = true;
  exportBtn.innerHTML = '<span class="spinner"></span>Rendering…';

  try {
    if (!map.loaded() || map.isMoving() || map.isZooming()) {
      await new Promise<void>((r) => map.once("idle", () => r()));
    }
    const center = map.getCenter();
    const data = await renderHighRes({
      styleId: currentStyleId,
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      width: w,
      height: h,
      pixelRatio: px,
      format,
      quality: 0.92,
    });

    if (data.skippedPins > 0 || data.skippedRoutes > 0) {
      // 3D pitch puts points behind the camera; warn the user once so the
      // export-complete toast that follows isn't silently misleading.
      const parts: string[] = [];
      if (data.skippedPins > 0) {
        parts.push(`${data.skippedPins} pin${data.skippedPins === 1 ? "" : "s"}`);
      }
      if (data.skippedRoutes > 0) {
        parts.push(`${data.skippedRoutes} route${data.skippedRoutes === 1 ? "" : "s"}`);
      }
      showStatus(
        `Skipped ${parts.join(" + ")} (behind the camera at this pitch).`,
        true,
        7000,
      );
    } else {
      showStatus("Exporting to Figma…");
    }

    parent.postMessage(
      {
        pluginMessage: {
          type: "export-map",
          bytes: data.bytes,
          width: w,
          height: h,
          styleLabel: STYLES.find((s) => s.id === currentStyleId)!.label,
          pins: data.pins,
          routes: data.routes,
          gridLines: data.gridLines,
          // Pitch is sent so the plugin can foreshorten each pin's ellipse
          // by cos(pitch) — matching what the user sees in the preview.
          pitch: map.getPitch(),
        },
      },
      "*",
    );
  } catch (err) {
    showStatus(err instanceof Error ? err.message : String(err), true);
    resetExportBtn();
  }
}

function resetExportBtn(): void {
  exportBtn.disabled = false;
  exportBtn.textContent = "Export";
}

exportBtn.addEventListener("click", () => void doExport());

// =============================================================================
// About modal
// =============================================================================

function openAbout(): void {
  aboutModal.hidden = false;
}
function closeAbout(): void {
  aboutModal.hidden = true;
}

aboutBtn.addEventListener("click", openAbout);
aboutClose.addEventListener("click", closeAbout);
aboutModal.addEventListener("click", (e) => {
  // Close when clicking the backdrop (but not the dialog itself).
  if (e.target === aboutModal) closeAbout();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !aboutModal.hidden) closeAbout();
});

// =============================================================================
// Side panel — collapse / expand + tab switching
// =============================================================================

function setPanelCollapsed(collapsed: boolean): void {
  // Panel slides over the map via transform — the map's container size never
  // changes, so no window resize and no fitFrame call is needed here.
  sidePanel.classList.toggle("collapsed", collapsed);
  panelToggle.classList.toggle("active", !collapsed);
  panelToggle.title = collapsed ? "Show side panel" : "Hide side panel";
  panelToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

panelToggle.addEventListener("click", () => {
  const isCollapsed = sidePanel.classList.contains("collapsed");
  setPanelCollapsed(!isCollapsed);
});

// First-run hint: dismiss when the user clicks "Got it", or when they
// click the panel toggle (they discovered it on their own — no longer
// needs prompting). Idempotent: subsequent calls are no-ops.
function dismissFirstRunHint(): void {
  if (firstRunHint.hidden) return;
  firstRunHint.hidden = true;
  parent.postMessage(
    { pluginMessage: { type: "save-first-run-hint" } },
    "*",
  );
}
firstRunDismiss.addEventListener("click", dismissFirstRunHint);
panelToggle.addEventListener("click", dismissFirstRunHint);

const panelTabs =
  document.querySelectorAll<HTMLButtonElement>(".panel-tab");
const panelPanes =
  document.querySelectorAll<HTMLElement>(".tab-pane");

panelTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    if (!target) return;
    panelTabs.forEach((t) => {
      const active = t === tab;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    panelPanes.forEach((p) => {
      p.classList.toggle("active", p.dataset.pane === target);
    });
  });
});

// Route external link clicks through the plugin sandbox so they open in the
// user's default browser regardless of iframe sandbox flags.
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const anchor = target.closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#")) return;
  if (!/^https?:\/\//i.test(href)) return;
  e.preventDefault();
  parent.postMessage({ pluginMessage: { type: "open-url", url: href } }, "*");
});

// =============================================================================
// Plugin → UI messages
// =============================================================================

window.addEventListener("message", (event: MessageEvent) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = (event.data as any)?.pluginMessage;
  if (!msg) return;

  if (msg.type === "init") {
    if (Array.isArray(msg.recent)) {
      recentSearches.splice(0, recentSearches.length, ...msg.recent);
    }
    if (typeof msg.orsKey === "string" && msg.orsKey.length > 0) {
      orsApiKey = msg.orsKey;
      showApiKeySavedMode();
    }
    // First-run hint pointing at the panel toggle. Only the first time on
    // this device. Small delay so the plugin window settles before the
    // hint pops in.
    if (msg.firstRunHintShown !== true) {
      window.setTimeout(() => {
        if (firstRunHint.hidden) firstRunHint.hidden = false;
      }, 700);
    }
    // Restore the user's last graticule preference.
    if (msg.graticuleVisible === true) {
      setGraticuleVisible(true, /* persist */ false);
    }
    // Restore the user's "export as layers" preference.
    if (msg.exportAsLayers === true) {
      setExportAsLayers(true, /* persist */ false);
    }
  } else if (msg.type === "export-complete") {
    showStatus("Done. Frame placed in Figma.");
    resetExportBtn();
  } else if (msg.type === "export-error") {
    showStatus(`Export error: ${msg.error ?? "unknown"}`, true);
    resetExportBtn();
  }
});

// =============================================================================
// Routes — Roads (OSRM) + Arc (bezier-bow), with From/To autocomplete
// =============================================================================

// A route is a sequence of >= 2 waypoints connected either by real driving
// directions (type: "roads", with a transport mode) or by a continuous
// bezier arc (type: "arc"). The `coordinates` are the rendered polyline;
// `waypoints` are the user's picks.
interface Route {
  id: string;
  waypoints: PlacePick[];
  type: "roads" | "arc";
  mode?: RoutingMode;        // only set for "roads" routes
  coordinates: [number, number][];
  distanceKm: number;
  color: string;
}

type RoutingMode = "driving-car" | "cycling-regular" | "foot-walking";

const routes: Route[] = [];
let routeSeq = 1;

// Current selected routing profile for the Routes tab (Roads). User picks via
// the segmented Car / Bike / Walk control; Arc tab ignores this.
let currentRoutingMode: RoutingMode = "driving-car";

// User-supplied OpenRouteService API key. Persisted via figma.clientStorage,
// loaded on init via the "init" message from the plugin sandbox.
let orsApiKey: string | null = null;

// ---- Geometry helpers -----------------------------------------------------

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 2D bezier arc — control point sits perpendicular to the start→end line at
// the midpoint, height proportional to line length, always biased toward the
// north pole so the curve reads as a "rising" connection like a flight path.
function arcCurve(
  start: [number, number],
  end: [number, number],
  steps = 80,
): [number, number][] {
  const [sx, sy] = start;
  const [ex, ey] = end;
  const dx = ex - sx;
  const dy = ey - sy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [start, end];
  let px = -dy / len;
  let py = dx / len;
  if (py < 0) { px = -px; py = -py; }
  const arcHeight = 0.22;
  const cx = (sx + ex) / 2 + px * len * arcHeight;
  const cy = (sy + ey) / 2 + py * len * arcHeight;
  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * sx + 2 * u * t * cx + t * t * ex;
    const y = u * u * sy + 2 * u * t * cy + t * t * ey;
    points.push([x, y]);
  }
  return points;
}

// Chained arc — a single bezier between each consecutive pair, joined end-
// to-end so the user gets one continuous polyline through every waypoint.
function multiArcCurve(points: Array<[number, number]>): [number, number][] {
  if (points.length < 2) return points.slice();
  const result: [number, number][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const segment = arcCurve(points[i], points[i + 1]);
    if (i === 0) result.push(...segment);
    else result.push(...segment.slice(1)); // skip the duplicated join point
  }
  return result;
}

// Display helpers for route list / export naming
function routeDisplayName(r: Route): string {
  const names = r.waypoints.map((w) => shortPlaceName(w.name));
  if (names.length <= 3) return names.join(" → ");
  return `${names[0]} → +${names.length - 2} → ${names[names.length - 1]}`;
}

function modeLabel(r: Route): string {
  if (r.type === "arc") return "Arc";
  switch (r.mode) {
    case "cycling-regular": return "Bike";
    case "foot-walking": return "Walk";
    default: return "Car";
  }
}

async function fetchOrsRoute(
  waypointCoords: Array<[number, number]>,
  mode: RoutingMode,
): Promise<{ coordinates: [number, number][]; distanceKm: number }> {
  if (!orsApiKey) {
    throw new Error(
      "Add your OpenRouteService API key (top of Routes tab) before using Roads.",
    );
  }
  if (waypointCoords.length < 2) {
    throw new Error("Need at least two waypoints for a route.");
  }

  let res: Response;
  try {
    res = await fetch(`${ORS_DIRECTIONS_BASE}/${mode}/geojson`, {
      method: "POST",
      headers: {
        Authorization: orsApiKey,
        "Content-Type": "application/json",
        Accept: "application/geo+json, application/json",
      },
      body: JSON.stringify({ coordinates: waypointCoords }),
    });
  } catch {
    throw new Error("Network error contacting OpenRouteService.");
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "Routing key rejected — double-check it's the OpenRouteService token.",
    );
  }
  if (res.status === 429) {
    throw new Error(
      "Routing rate limit reached. Daily free quota is 2,000 routes.",
    );
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const errBody = (await res.json()) as { error?: { message?: string } };
      if (errBody?.error?.message) detail = errBody.error.message;
    } catch {
      /* ignore */
    }
    throw new Error(`Routing failed: ${detail}`);
  }

  const data = (await res.json()) as {
    type: "FeatureCollection";
    features?: Array<{
      geometry: { type: "LineString"; coordinates: [number, number][] };
      properties?: { summary?: { distance?: number; duration?: number } };
    }>;
  };

  if (!data.features || data.features.length === 0) {
    throw new Error("No drivable route found between those points.");
  }

  const f = data.features[0];
  const distance = f.properties?.summary?.distance ?? 0;
  return {
    coordinates: f.geometry.coordinates,
    distanceKm: distance / 1000,
  };
}

// ---- Routes layer ---------------------------------------------------------

function routesGeoJSON() {
  return {
    type: "FeatureCollection" as const,
    features: routes.map((r) => ({
      type: "Feature" as const,
      properties: { id: r.id, color: r.color, type: r.type },
      geometry: { type: "LineString" as const, coordinates: r.coordinates },
    })),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureRoutesLayers(target: any): void {
  const data = routesGeoJSON();
  if (!target.getSource(ROUTES_SOURCE)) {
    target.addSource(ROUTES_SOURCE, { type: "geojson", data });
  } else {
    target.getSource(ROUTES_SOURCE).setData(data);
  }
  // White halo underneath — keeps lines legible on busy basemaps.
  if (!target.getLayer(`${ROUTES_LINE_LAYER}-halo`)) {
    target.addLayer({
      id: `${ROUTES_LINE_LAYER}-halo`,
      type: "line",
      source: ROUTES_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-width": 7,
        "line-opacity": 0.7,
      },
    });
  }
  if (!target.getLayer(ROUTES_LINE_LAYER)) {
    target.addLayer({
      id: ROUTES_LINE_LAYER,
      type: "line",
      source: ROUTES_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": 4,
      },
    });
  }
}

function refreshRoutesSource(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const src = map.getSource(ROUTES_SOURCE) as any;
  if (src) src.setData(routesGeoJSON());
}

// ---- Latitude / longitude graticule --------------------------------------

let graticuleVisible = false;

// Whether the next Export should produce native Figma layers (pins, routes,
// grid as their own editable groups) or a single flat PNG. Default off so a
// fresh install gets the more immediately-recognisable "drop the map into
// a frame" behaviour. Persisted per device.
let exportAsLayers = false;

// Build the GeoJSON once at module init — the data is purely geometric and
// doesn't depend on map state. Meridians get a dense vertex strip so they
// curve smoothly when projected onto the globe.
const graticuleData = (() => {
  const features: Array<{
    type: "Feature";
    properties: { kind: "meridian" | "parallel"; value: number };
    geometry: { type: "LineString"; coordinates: [number, number][] };
  }> = [];
  for (let lng = -180; lng <= 180; lng += GRATICULE_SPACING_DEG) {
    const coords: [number, number][] = [];
    for (let lat = -85; lat <= 85; lat += 2) coords.push([lng, lat]);
    features.push({
      type: "Feature",
      properties: { kind: "meridian", value: lng },
      geometry: { type: "LineString", coordinates: coords },
    });
  }
  for (let lat = -80; lat <= 80; lat += GRATICULE_SPACING_DEG) {
    const coords: [number, number][] = [];
    for (let lng = -180; lng <= 180; lng += 5) coords.push([lng, lat]);
    features.push({
      type: "Feature",
      properties: { kind: "parallel", value: lat },
      geometry: { type: "LineString", coordinates: coords },
    });
  }
  return { type: "FeatureCollection" as const, features };
})();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureGraticuleLayers(target: any): void {
  if (!target.getSource(GRATICULE_SOURCE)) {
    target.addSource(GRATICULE_SOURCE, { type: "geojson", data: graticuleData });
  }
  if (!target.getLayer(GRATICULE_LAYER)) {
    // Insert below any existing overlays so the grid sits underneath
    // routes and pins. If neither exists yet, the layer goes on top of
    // the basemap (which is also what we want).
    const beforeId =
      target.getLayer(`${ROUTES_LINE_LAYER}-halo`)
        ? `${ROUTES_LINE_LAYER}-halo`
        : target.getLayer(PINS_CIRCLE_LAYER)
          ? PINS_CIRCLE_LAYER
          : undefined;
    target.addLayer(
      {
        id: GRATICULE_LAYER,
        type: "line",
        source: GRATICULE_SOURCE,
        paint: {
          "line-color": "#7a7a7a",
          "line-width": 0.6,
          "line-opacity": 0.55,
          "line-dasharray": [3, 3],
        },
      },
      beforeId,
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function removeGraticuleLayers(target: any): void {
  if (target.getLayer(GRATICULE_LAYER)) target.removeLayer(GRATICULE_LAYER);
  if (target.getSource(GRATICULE_SOURCE)) target.removeSource(GRATICULE_SOURCE);
}

function setGraticuleVisible(visible: boolean, persist = true): void {
  graticuleVisible = visible;
  if (visible) ensureGraticuleLayers(map);
  else removeGraticuleLayers(map);
  // Sync the checkbox state. If this was called by the user clicking the
  // toggle the checkbox is already in the right state; setting it again is
  // idempotent and matters for the persistence-restore path.
  graticuleToggle.checked = visible;
  if (persist) {
    parent.postMessage(
      { pluginMessage: { type: "save-graticule", visible } },
      "*",
    );
  }
}

const graticuleToggle = $<HTMLInputElement>("#toggle-graticule");
graticuleToggle.addEventListener("change", () => {
  setGraticuleVisible(graticuleToggle.checked);
});

// ---- Export-as-layers toggle ---------------------------------------------

function setExportAsLayers(value: boolean, persist = true): void {
  exportAsLayers = value;
  exportLayersToggle.checked = value;
  if (persist) {
    parent.postMessage(
      { pluginMessage: { type: "save-export-as-layers", value } },
      "*",
    );
  }
}

const exportLayersToggle = $<HTMLInputElement>("#toggle-export-layers");
exportLayersToggle.addEventListener("change", () => {
  setExportAsLayers(exportLayersToggle.checked);
});

// ---- Reusable place autocomplete (per-input instance) ---------------------

interface PlacePick { name: string; lng: number; lat: number; }
interface PlaceAutocompleteHandle {
  getCurrent(): PlacePick | null;
  reset(): void;
}

function attachPlaceAutocomplete(
  input: HTMLInputElement,
  dropdown: HTMLDivElement,
  onPick: (place: PlacePick) => void,
): PlaceAutocompleteHandle {
  let current: PlacePick | null = null;
  let suggestions: NominatimResult[] = [];
  let hi = -1;
  let timer: number | undefined;
  let abort: AbortController | null = null;

  const close = (): void => {
    hi = -1;
    dropdown.classList.remove("open");
    dropdown.innerHTML = "";
  };

  const updateHi = (): void => {
    dropdown.querySelectorAll(".suggestion-item").forEach((el, i) => {
      el.classList.toggle("highlighted", i === hi);
    });
  };

  const pick = (i: number): void => {
    const r = suggestions[i];
    if (!r) return;
    current = {
      name: r.display_name,
      lng: parseFloat(r.lon),
      lat: parseFloat(r.lat),
    };
    input.value = r.display_name;
    close();
    onPick(current);
  };

  const renderItems = (): void => {
    dropdown.innerHTML = "";
    suggestions.forEach((r, i) => {
      const item = document.createElement("div");
      item.className = "recent-item suggestion-item";
      if (i === hi) item.classList.add("highlighted");
      item.innerHTML =
        `<span class="leading">›</span>` +
        `<span class="suggest-name">${escapeHtml(r.display_name)}</span>`;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pick(i);
      });
      item.addEventListener("mouseover", () => {
        hi = i;
        updateHi();
      });
      dropdown.appendChild(item);
    });
    dropdown.classList.add("open");
  };

  const fetchAndShow = async (q: string): Promise<void> => {
    if (abort) abort.abort();
    abort = new AbortController();
    try {
      const url =
        "https://nominatim.openstreetmap.org/search?format=json&limit=" +
        SUGGEST_LIMIT +
        "&q=" + encodeURIComponent(q);
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: abort.signal,
      });
      if (!res.ok) return;
      const data = (await res.json()) as NominatimResult[];
      if (!Array.isArray(data) || data.length === 0) {
        close();
        return;
      }
      suggestions = data;
      hi = -1;
      renderItems();
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
    }
  };

  const debounce = (val: string): void => {
    if (timer != null) window.clearTimeout(timer);
    if (abort) abort.abort();
    const q = val.trim();
    if (LATLNG_RE.test(q) || q.length < SUGGEST_MIN_LEN) {
      close();
      return;
    }
    timer = window.setTimeout(() => void fetchAndShow(q), SUGGEST_DEBOUNCE_MS);
  };

  input.addEventListener("input", () => {
    current = null;
    debounce(input.value);
  });
  input.addEventListener("focus", () => {
    if (input.value.trim().length >= SUGGEST_MIN_LEN) debounce(input.value);
  });
  input.addEventListener("blur", () => {
    setTimeout(close, 150);
  });
  input.addEventListener("keydown", (e) => {
    if (!dropdown.classList.contains("open")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Enter" && hi >= 0) {
      e.preventDefault();
      pick(hi);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (suggestions.length === 0) return;
      hi = e.key === "ArrowDown"
        ? (hi < suggestions.length - 1 ? hi + 1 : 0)
        : (hi > 0 ? hi - 1 : suggestions.length - 1);
      updateHi();
    }
  });

  return {
    getCurrent: () => current,
    reset: () => {
      current = null;
      input.value = "";
      close();
    },
  };
}

// ---- Shared helpers used by both Arc and Routes tab sections -------------

function fitBoundsToRoute(coords: [number, number][]): void {
  if (coords.length < 2) return;
  let minLng = coords[0][0];
  let maxLng = coords[0][0];
  let minLat = coords[0][1];
  let maxLat = coords[0][1];
  coords.forEach(([lng, lat]) => {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  });
  map.fitBounds(
    [[minLng, minLat], [maxLng, maxLat]],
    { padding: 60, duration: 700, maxZoom: 14 },
  );
}

function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

function shortPlaceName(s: string): string {
  return (s.split(",")[0] || s).trim();
}

// Each tab's renderList is registered here so an add/remove from one tab
// refreshes the count + list in the other tab's panel too.
const sectionRenderers: Array<() => void> = [];

function refreshAllRouteLists(): void {
  for (const r of sectionRenderers) r();
}

function removeRoute(id: string): void {
  const i = routes.findIndex((r) => r.id === id);
  if (i === -1) return;
  routes.splice(i, 1);
  refreshRoutesSource();
  refreshAllRouteLists();
}

// ---- Section factory — wires up the dynamic-waypoint form, list, and
// add/clear actions for one tab (Arc or Routes). Both tabs share the same
// routes[] state but each only sees its own type in the list view.

interface RouteSectionOpts {
  type: "roads" | "arc";
  waypointsContainerId: string;
  addStopBtnId: string;
  addBtnId: string;
  clearBtnId: string;
  countElId: string;
  listElId: string;
  emptyElId: string;
  addLabel: string;
  nounSingle: string;
  nounPlural: string;
}

const MIN_WAYPOINTS = 2;
const MAX_WAYPOINTS = 8;

interface WaypointEntry {
  rowEl: HTMLDivElement;
  input: HTMLInputElement;
  autocomplete: PlaceAutocompleteHandle;
  removeBtn: HTMLButtonElement;
  labelEl: HTMLLabelElement;
}

function setupRouteSection(opts: RouteSectionOpts): void {
  const waypointsContainer =
    $<HTMLDivElement>("#" + opts.waypointsContainerId);
  const addStopBtn = $<HTMLButtonElement>("#" + opts.addStopBtnId);
  const addBtn = $<HTMLButtonElement>("#" + opts.addBtnId);
  const clearBtn = $<HTMLButtonElement>("#" + opts.clearBtnId);
  const countEl = $<HTMLSpanElement>("#" + opts.countElId);
  const listEl = $<HTMLDivElement>("#" + opts.listElId);
  const emptyEl = $<HTMLElement>("#" + opts.emptyElId);

  const waypoints: WaypointEntry[] = [];

  const updateEnabled = (): void => {
    const allPicked =
      waypoints.length >= MIN_WAYPOINTS &&
      waypoints.every((wp) => wp.autocomplete.getCurrent() !== null);
    addBtn.disabled = !allPicked;
    addStopBtn.disabled = waypoints.length >= MAX_WAYPOINTS;
  };

  const labelForIndex = (i: number, total: number): string => {
    if (i === 0) return "From";
    if (i === total - 1) return "To";
    return "Via";
  };

  const placeholderForLabel = (label: string): string => {
    if (label === "From") return "Start location";
    if (label === "To") return "End location";
    return "Stop location";
  };

  const relabelAll = (): void => {
    waypoints.forEach((wp, i) => {
      const label = labelForIndex(i, waypoints.length);
      wp.labelEl.textContent = label;
      wp.input.placeholder = placeholderForLabel(label);
      // Only the middle (Via) rows show a remove button.
      const isMiddle = i > 0 && i < waypoints.length - 1;
      wp.removeBtn.style.display = isMiddle ? "" : "none";
    });
  };

  const createWaypointEntry = (): WaypointEntry => {
    const row = document.createElement("div");
    row.className = "waypoint-row";
    row.innerHTML = `
      <div class="waypoint-row-top">
        <label class="route-label">From</label>
        <button type="button" class="remove-waypoint"
                aria-label="Remove this stop" title="Remove this stop">×</button>
      </div>
      <div class="autocomplete-wrap">
        <input class="route-input" type="search"
               autocomplete="off" spellcheck="false" />
        <div class="recent-pop autocomplete-pop" role="listbox"></div>
      </div>
    `;
    const input = row.querySelector(".route-input") as HTMLInputElement;
    const pop = row.querySelector(".autocomplete-pop") as HTMLDivElement;
    const labelEl = row.querySelector(".route-label") as HTMLLabelElement;
    const removeBtn = row.querySelector(".remove-waypoint") as HTMLButtonElement;
    const autocomplete = attachPlaceAutocomplete(input, pop, () =>
      updateEnabled(),
    );
    input.addEventListener("input", updateEnabled);

    const entry: WaypointEntry = { rowEl: row, input, autocomplete, removeBtn, labelEl };

    removeBtn.addEventListener("click", () => {
      if (waypoints.length <= MIN_WAYPOINTS) return;
      const idx = waypoints.indexOf(entry);
      if (idx === -1) return;
      waypoints.splice(idx, 1);
      row.remove();
      relabelAll();
      updateEnabled();
    });

    return entry;
  };

  const insertWaypointBeforeLast = (): void => {
    if (waypoints.length >= MAX_WAYPOINTS) return;
    const entry = createWaypointEntry();
    const lastIdx = waypoints.length - 1;
    waypoints.splice(lastIdx, 0, entry);
    waypointsContainer.insertBefore(
      entry.rowEl,
      waypoints[waypoints.length - 1].rowEl,
    );
    relabelAll();
    updateEnabled();
    entry.input.focus();
  };

  const addInitialWaypoint = (): void => {
    const entry = createWaypointEntry();
    waypoints.push(entry);
    waypointsContainer.appendChild(entry.rowEl);
  };

  // Initial setup: From + To.
  addInitialWaypoint();
  addInitialWaypoint();
  relabelAll();
  updateEnabled();

  addStopBtn.addEventListener("click", insertWaypointBeforeLast);

  const renderList = (): void => {
    const items = routes.filter((r) => r.type === opts.type);
    const n = items.length;
    countEl.textContent =
      n === 0
        ? `No ${opts.nounPlural}`
        : `${n} ${n === 1 ? opts.nounSingle : opts.nounPlural}`;
    clearBtn.disabled = n === 0;
    emptyEl.style.display = n === 0 ? "block" : "none";
    listEl.innerHTML = "";

    for (const r of items) {
      const row = document.createElement("div");
      row.className = "route-item";
      row.dataset.routeId = r.id;
      row.title = `${r.waypoints
        .map((w) => w.name)
        .join("\n→ ")}\nDouble-click to fit map`;
      row.innerHTML = `
        <div class="stripe" style="background:${r.color}"></div>
        <div class="meta">
          <span class="label">${escapeHtml(routeDisplayName(r))}</span>
          <span class="sub">${modeLabel(r)} · ${formatDistance(r.distanceKm)}</span>
        </div>
        <button class="remove" type="button" aria-label="Remove" title="Remove">×</button>
      `;
      row.addEventListener("dblclick", (e) => {
        const t = e.target as HTMLElement;
        if (t.closest(".remove")) return;
        fitBoundsToRoute(r.coordinates);
      });
      row.querySelector(".remove")!.addEventListener("click", () => {
        removeRoute(r.id);
      });
      listEl.appendChild(row);
    }
  };

  sectionRenderers.push(renderList);

  const clearAllOfType = (): void => {
    for (let i = routes.length - 1; i >= 0; i--) {
      if (routes[i].type === opts.type) routes.splice(i, 1);
    }
    refreshRoutesSource();
    refreshAllRouteLists();
  };

  const resetForm = (): void => {
    // Drop any Via rows added by the user; reset From + To values.
    while (waypoints.length > MIN_WAYPOINTS) {
      const last = waypoints.pop();
      last?.rowEl.remove();
    }
    waypoints.forEach((wp) => wp.autocomplete.reset());
    relabelAll();
    updateEnabled();
  };

  const addOne = async (): Promise<void> => {
    const picks = waypoints.map((wp) => wp.autocomplete.getCurrent());
    if (picks.length < 2 || picks.some((p) => p === null)) return;
    const validPicks = picks as PlacePick[];

    // ORS rejects consecutive duplicates and arcs would collapse.
    for (let i = 1; i < validPicks.length; i++) {
      if (
        validPicks[i].lng === validPicks[i - 1].lng &&
        validPicks[i].lat === validPicks[i - 1].lat
      ) {
        showStatus("Consecutive stops are at the same location.", true);
        return;
      }
    }

    addBtn.disabled = true;
    addBtn.innerHTML = '<span class="spinner"></span>Adding…';

    try {
      const waypointCoords: Array<[number, number]> = validPicks.map((p) => [
        p.lng,
        p.lat,
      ]);

      let coordinates: [number, number][];
      let distanceKm: number;
      let mode: RoutingMode | undefined;
      if (opts.type === "roads") {
        mode = currentRoutingMode;
        const r = await fetchOrsRoute(waypointCoords, mode);
        coordinates = r.coordinates;
        distanceKm = r.distanceKm;
      } else {
        coordinates = multiArcCurve(waypointCoords);
        // Arcs report cumulative great-circle distance.
        distanceKm = 0;
        for (let i = 1; i < waypointCoords.length; i++) {
          distanceKm += haversineKm(waypointCoords[i - 1], waypointCoords[i]);
        }
      }

      const id = `route-${Date.now()}-${routeSeq++}`;
      const sameTypeCount = routes.filter((r) => r.type === opts.type).length;
      const color = ROUTE_COLORS[sameTypeCount % ROUTE_COLORS.length];
      routes.push({
        id,
        waypoints: validPicks,
        type: opts.type,
        mode,
        coordinates,
        distanceKm,
        color,
      });
      refreshRoutesSource();
      refreshAllRouteLists();
      fitBoundsToRoute(coordinates);
      resetForm();
      showStatus(
        `Added ${opts.type === "roads" ? "driving route" : "arc"} ` +
        `(${formatDistance(distanceKm)})`,
      );
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err), true);
    } finally {
      addBtn.textContent = opts.addLabel;
      updateEnabled();
    }
  };

  addBtn.addEventListener("click", () => void addOne());
  clearBtn.addEventListener("click", clearAllOfType);
}

// Routing-mode (Car / Bike / Walk) selector — only the Routes tab has this
// control; Arc tab ignores it.
document
  .querySelectorAll<HTMLButtonElement>(".mode-selector .seg-btn")
  .forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.routingMode as RoutingMode | undefined;
      if (!mode || mode === currentRoutingMode) return;
      currentRoutingMode = mode;
      document
        .querySelectorAll<HTMLButtonElement>(".mode-selector .seg-btn")
        .forEach((b) => {
          const active = b === btn;
          b.classList.toggle("active", active);
          b.setAttribute("aria-selected", active ? "true" : "false");
        });
    });
  });

setupRouteSection({
  type: "arc",
  waypointsContainerId: "arc-waypoints",
  addStopBtnId: "add-arc-stop",
  addBtnId: "add-arc",
  clearBtnId: "clear-arcs",
  countElId: "arc-count",
  listElId: "arc-list",
  emptyElId: "arc-empty",
  addLabel: "+ Add arc",
  nounSingle: "arc",
  nounPlural: "arcs",
});

setupRouteSection({
  type: "roads",
  waypointsContainerId: "route-waypoints",
  addStopBtnId: "add-route-stop",
  addBtnId: "add-route",
  clearBtnId: "clear-routes",
  countElId: "route-count",
  listElId: "route-list",
  emptyElId: "route-empty",
  addLabel: "+ Add route",
  nounSingle: "route",
  nounPlural: "routes",
});

// ---- OpenRouteService API key UI ------------------------------------------

const apiKeySection = $<HTMLDivElement>("#api-key-section");
const apiKeyInput = $<HTMLInputElement>("#api-key-input");
const apiKeyInputWrap = $<HTMLDivElement>("#api-key-input-wrap");
const apiKeySaveBtn = $<HTMLButtonElement>("#api-key-save");
const apiKeySavedMsg = $<HTMLDivElement>("#api-key-saved-msg");
const apiKeyMask = $<HTMLElement>("#api-key-mask");
const apiKeyChangeBtn = $<HTMLButtonElement>("#api-key-change");

function showApiKeyInputMode(): void {
  // Expanded card: input field + Save button + full instructions visible.
  apiKeyInputWrap.hidden = false;
  apiKeySavedMsg.hidden = true;
  apiKeySection.classList.remove("minimized");
  apiKeyInput.value = "";
  apiKeySaveBtn.disabled = true;
}

function showApiKeySavedMode(): void {
  // Collapsed: single-line "✓ Routing key saved · •••••••• · Change",
  // no card chrome, so From / To get visual focus.
  // The mask reveals nothing about the key — even partial exposure can be
  // a non-starter for some teams' security policies. The fixed-width chip is
  // kept purely as a visual confirmation that a key is present.
  apiKeyInputWrap.hidden = true;
  apiKeySavedMsg.hidden = false;
  apiKeySection.classList.add("minimized");
  apiKeyMask.textContent = "••••••••";
}

function persistOrsKey(key: string): void {
  parent.postMessage(
    { pluginMessage: { type: "save-routing-key", key } },
    "*",
  );
}

function commitOrsKeyFromInput(): void {
  const newKey = apiKeyInput.value.trim();
  if (!newKey) return;
  orsApiKey = newKey;
  showApiKeySavedMode();
  persistOrsKey(newKey);
  showStatus("Routing API key saved.");
}

// Enable Save the moment there's something in the field. The browser fires
// `input` on both typing and paste, so this covers both entry methods.
apiKeyInput.addEventListener("input", () => {
  apiKeySaveBtn.disabled = apiKeyInput.value.trim().length === 0;
});

apiKeySaveBtn.addEventListener("click", commitOrsKeyFromInput);

// Enter inside the input also commits, since users will reach for it.
apiKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !apiKeySaveBtn.disabled) {
    e.preventDefault();
    commitOrsKeyFromInput();
  }
});

apiKeyChangeBtn.addEventListener("click", () => {
  orsApiKey = null;
  showApiKeyInputMode();
  persistOrsKey("");
  apiKeyInput.focus();
});

// =============================================================================
// Boot
// =============================================================================

window.addEventListener("resize", fitFrame);

populateSelects();
applySize(1920, 1080);

requestAnimationFrame(() => {
  fitFrame();
  map.once("load", () => {
    fitFrame();
    syncViewInputs();
    showStatus("Pan, zoom and frame your section.");
    parent.postMessage({ pluginMessage: { type: "ready" } }, "*");
  });
});

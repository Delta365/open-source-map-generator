// Map Generator — Figma plugin main thread.
//
// Lives in the Figma sandbox. Handles:
// - Materialising the exported PNG/JPEG into a frame at the user-chosen size.
// - Persisting recent searches via clientStorage.
// - Initial bootstrap data for the UI.

const RECENT_KEY = "map-generator:recent-searches";
const ORS_KEY_KEY = "map-generator:ors-api-key";
const FIRST_RUN_HINT_KEY = "map-generator:first-run-hint-shown";
const GRATICULE_KEY = "map-generator:graticule-visible";
const EXPORT_AS_LAYERS_KEY = "map-generator:export-as-layers";

// Single fixed window size: the side panel slides over the map (overlay),
// so we don't need to resize when it opens or closes.
figma.showUI(__html__, {
  width: 760,
  height: 640,
  themeColors: true,
  title: "Open Source - Map Generator",
});

interface ExportPin {
  x: number;
  y: number;
  label: string;
  color: string;
}

interface ExportRoute {
  name: string;
  color: string;
  type: "roads" | "arc";
  points: { x: number; y: number }[];
}

// Each visible segment of a graticule line, projected to screen pixels.
interface ExportGridLine {
  name: string;
  points: { x: number; y: number }[];
}

interface ExportMessage {
  type: "export-map";
  bytes: Uint8Array;
  width: number;
  height: number;
  styleLabel?: string;
  pins?: ExportPin[];
  routes?: ExportRoute[];
  gridLines?: ExportGridLine[];
  // Camera pitch in degrees, 0–60. Used to foreshorten pin ellipses so they
  // look like ground-aligned discs at the same pitch the user is viewing.
  pitch?: number;
}

interface ReadyMessage {
  type: "ready";
}

interface SaveRecentMessage {
  type: "save-recent";
  recent: string[];
}

interface SaveRoutingKeyMessage {
  type: "save-routing-key";
  key: string;
}

interface SaveFirstRunHintMessage {
  type: "save-first-run-hint";
}

interface SaveGraticuleMessage {
  type: "save-graticule";
  visible: boolean;
}

interface SaveExportAsLayersMessage {
  type: "save-export-as-layers";
  value: boolean;
}

interface CloseMessage {
  type: "close";
}

interface ResizeMessage {
  type: "resize";
  width: number;
  height: number;
}

interface OpenUrlMessage {
  type: "open-url";
  url: string;
}

type PluginMessage =
  | ExportMessage
  | ReadyMessage
  | SaveRecentMessage
  | SaveRoutingKeyMessage
  | SaveFirstRunHintMessage
  | SaveGraticuleMessage
  | SaveExportAsLayersMessage
  | CloseMessage
  | ResizeMessage
  | OpenUrlMessage;

figma.ui.onmessage = async (msg: PluginMessage) => {
  if (msg.type === "ready") {
    let recent: string[] = [];
    let orsKey = "";
    let firstRunHintShown = false;
    let graticuleVisible = false;
    let exportAsLayers = false;
    try {
      const stored = await figma.clientStorage.getAsync(RECENT_KEY);
      if (Array.isArray(stored)) {
        recent = stored.filter((x): x is string => typeof x === "string").slice(0, 10);
      }
    } catch {
      // clientStorage failure is non-critical; ship empty recents.
    }
    try {
      const k = await figma.clientStorage.getAsync(ORS_KEY_KEY);
      if (typeof k === "string") orsKey = k;
    } catch {
      // Same — non-critical.
    }
    try {
      const seen = await figma.clientStorage.getAsync(FIRST_RUN_HINT_KEY);
      firstRunHintShown = seen === true;
    } catch {
      // Default to false (show the hint) if storage isn't readable.
    }
    try {
      const g = await figma.clientStorage.getAsync(GRATICULE_KEY);
      graticuleVisible = g === true;
    } catch {
      // Default to off if not readable.
    }
    try {
      const e = await figma.clientStorage.getAsync(EXPORT_AS_LAYERS_KEY);
      exportAsLayers = e === true;
    } catch {
      // Default to off (flat PNG export) if not readable.
    }
    figma.ui.postMessage({
      type: "init",
      recent,
      orsKey,
      firstRunHintShown,
      graticuleVisible,
      exportAsLayers,
    });
    return;
  }

  if (msg.type === "save-recent") {
    try {
      const sanitized = (msg.recent ?? [])
        .filter((x): x is string => typeof x === "string")
        .slice(0, 10);
      await figma.clientStorage.setAsync(RECENT_KEY, sanitized);
    } catch {
      // Best-effort; surface nothing if storage is unavailable.
    }
    return;
  }

  if (msg.type === "save-routing-key") {
    try {
      const key = typeof msg.key === "string" ? msg.key.trim() : "";
      if (key) {
        await figma.clientStorage.setAsync(ORS_KEY_KEY, key);
      } else {
        // Empty string means "clear it".
        await figma.clientStorage.deleteAsync(ORS_KEY_KEY);
      }
    } catch {
      // Best-effort.
    }
    return;
  }

  if (msg.type === "save-first-run-hint") {
    try {
      await figma.clientStorage.setAsync(FIRST_RUN_HINT_KEY, true);
    } catch {
      // Worst case the hint shows again next session; not a real problem.
    }
    return;
  }

  if (msg.type === "save-graticule") {
    try {
      await figma.clientStorage.setAsync(GRATICULE_KEY, msg.visible === true);
    } catch {
      // Worst case the toggle defaults back to off on next session.
    }
    return;
  }

  if (msg.type === "save-export-as-layers") {
    try {
      await figma.clientStorage.setAsync(EXPORT_AS_LAYERS_KEY, msg.value === true);
    } catch {
      // Worst case the toggle defaults back to off on next session.
    }
    return;
  }

  if (msg.type === "resize") {
    const w = Math.max(560, Math.min(1600, Math.round(msg.width)));
    const h = Math.max(480, Math.min(1200, Math.round(msg.height)));
    figma.ui.resize(w, h);
    return;
  }

  if (msg.type === "close") {
    figma.closePlugin();
    return;
  }

  if (msg.type === "open-url") {
    // Hardened: only forward valid http(s) URLs to figma.openExternal so a
    // malicious href can't talk us into opening unexpected schemes.
    if (typeof msg.url === "string" && /^https?:\/\//i.test(msg.url)) {
      try {
        figma.openExternal(msg.url);
      } catch {
        // Older API levels may not have openExternal; nothing else we can do.
      }
    }
    return;
  }

  if (msg.type === "export-map") {
    try {
      if (!(msg.bytes instanceof Uint8Array) || msg.bytes.length === 0) {
        throw new Error("No image bytes received from the UI.");
      }

      const w = Math.max(1, Math.round(msg.width || 1920));
      const h = Math.max(1, Math.round(msg.height || 1080));
      const pins = msg.pins ?? [];
      const routes = msg.routes ?? [];
      const gridLines = msg.gridLines ?? [];
      const hasOverlays =
        pins.length > 0 || routes.length > 0 || gridLines.length > 0;

      // figma.createImage accepts both PNG and JPEG byte arrays.
      const image = figma.createImage(msg.bytes);

      const frame = figma.createFrame();
      const labelSuffix = msg.styleLabel ? ` — ${msg.styleLabel}` : "";
      frame.name = `Map ${w}×${h}${labelSuffix}`;
      frame.resizeWithoutConstraints(w, h);
      frame.clipsContent = true;
      frame.cornerRadius = 0;

      const center = figma.viewport.center;
      frame.x = Math.round(center.x - w / 2);
      frame.y = Math.round(center.y - h / 2);

      figma.currentPage.appendChild(frame);

      if (!hasOverlays) {
        // Simple case — single image fill on the frame itself, same as
        // before. No nested rectangle.
        frame.fills = [
          { type: "IMAGE", scaleMode: "FILL", imageHash: image.hash },
        ];
      } else {
        // Layered case — empty frame fill + Map rect, then Routes group,
        // then Pins group on top. Each is its own editable Figma layer.
        frame.fills = [];

        const mapRect = figma.createRectangle();
        mapRect.name = "Map";
        mapRect.resizeWithoutConstraints(w, h);
        mapRect.x = 0;
        mapRect.y = 0;
        mapRect.fills = [
          { type: "IMAGE", scaleMode: "FILL", imageHash: image.hash },
        ];
        frame.appendChild(mapRect);

        // Grid first, so it draws above the map raster but below the
        // routes and pins. Each visible segment of a graticule line is its
        // own native Figma vector polyline so users can recolour, restroke,
        // or hide the whole grid as one selection.
        if (gridLines.length > 0) {
          const gridFrame = figma.createFrame();
          gridFrame.name = "Grid";
          gridFrame.resizeWithoutConstraints(w, h);
          gridFrame.x = 0;
          gridFrame.y = 0;
          gridFrame.fills = [];
          gridFrame.clipsContent = false;

          for (const line of gridLines) {
            if (!Array.isArray(line.points) || line.points.length < 2) continue;
            const v = figma.createVector();
            v.name = line.name;
            v.vectorPaths = [
              { windingRule: "NONE", data: buildPathData(line.points) },
            ];
            // Match the preview style: subtle grey, low opacity, dashed.
            v.strokes = [
              {
                type: "SOLID",
                color: { r: 0.48, g: 0.48, b: 0.48 },
                opacity: 0.55,
              },
            ];
            v.strokeWeight = 0.5;
            v.strokeCap = "ROUND";
            v.strokeJoin = "ROUND";
            v.dashPattern = [2, 2];
            v.fills = [];
            gridFrame.appendChild(v);
          }
          frame.appendChild(gridFrame);
        }

        if (routes.length > 0) {
          const routesFrame = figma.createFrame();
          routesFrame.name = "Routes";
          routesFrame.resizeWithoutConstraints(w, h);
          routesFrame.x = 0;
          routesFrame.y = 0;
          routesFrame.fills = [];
          routesFrame.clipsContent = false;

          for (const route of routes) {
            if (!Array.isArray(route.points) || route.points.length < 2) continue;
            const v = figma.createVector();
            v.name = route.name;
            v.vectorPaths = [
              { windingRule: "NONE", data: buildPathData(route.points) },
            ];
            v.strokes = [{ type: "SOLID", color: hexToRgb(route.color) }];
            v.strokeWeight = 4;
            v.strokeCap = "ROUND";
            v.strokeJoin = "ROUND";
            v.fills = [];
            routesFrame.appendChild(v);
          }
          frame.appendChild(routesFrame);
        }

        if (pins.length > 0) {
          // Text labels need a font loaded before figma.createText() can be
          // populated. Inter Regular is Figma's always-available default.
          await figma.loadFontAsync({ family: "Inter", style: "Regular" });

          const pinsFrame = figma.createFrame();
          pinsFrame.name = "Pins";
          pinsFrame.resizeWithoutConstraints(w, h);
          pinsFrame.x = 0;
          pinsFrame.y = 0;
          pinsFrame.fills = [];
          pinsFrame.clipsContent = false;

          // Match MapLibre's circle-radius:8 (diameter 16). Each pin is a
          // ground-aligned disc, so when the map is pitched, the ellipse
          // is foreshortened vertically by cos(pitch).
          const dotW = 16;
          const pitchDeg = typeof msg.pitch === "number"
            ? Math.max(0, Math.min(60, msg.pitch))
            : 0;
          const dotH = Math.max(2, dotW * Math.cos((pitchDeg * Math.PI) / 180));

          for (const pin of pins) {
            const ellipse = figma.createEllipse();
            ellipse.name = pin.label || "Pin";
            ellipse.resize(dotW, dotH);
            ellipse.x = pin.x - dotW / 2;
            ellipse.y = pin.y - dotH / 2;
            ellipse.fills = [
              { type: "SOLID", color: hexToRgb(pin.color) },
            ];
            ellipse.strokes = [
              { type: "SOLID", color: { r: 1, g: 1, b: 1 } },
            ];
            ellipse.strokeWeight = 2;
            pinsFrame.appendChild(ellipse);

            if (pin.label) {
              const text = figma.createText();
              text.fontName = { family: "Inter", style: "Regular" };
              text.characters = pin.label;
              text.fontSize = 12;
              text.fills = [
                { type: "SOLID", color: { r: 0.12, g: 0.12, b: 0.12 } },
              ];
              // White outline so the label stays legible on any basemap.
              text.strokes = [
                { type: "SOLID", color: { r: 1, g: 1, b: 1 } },
              ];
              text.strokeWeight = 3;
              text.strokeAlign = "OUTSIDE";
              text.name = pin.label;
              // Below the (possibly foreshortened) dot, horizontally centred.
              text.x = Math.round(pin.x - text.width / 2);
              text.y = Math.round(pin.y + dotH / 2 + 4);
              pinsFrame.appendChild(text);
            }
          }
          frame.appendChild(pinsFrame);
        }
      }

      figma.currentPage.selection = [frame];
      figma.viewport.scrollAndZoomIntoView([frame]);

      figma.ui.postMessage({ type: "export-complete" });
      const overlayParts: string[] = [];
      if (pins.length > 0) {
        overlayParts.push(`${pins.length} pin${pins.length === 1 ? "" : "s"}`);
      }
      if (routes.length > 0) {
        overlayParts.push(`${routes.length} route${routes.length === 1 ? "" : "s"}`);
      }
      if (gridLines.length > 0) overlayParts.push("grid");
      const overlayNote = overlayParts.length > 0
        ? ` (with ${overlayParts.join(" + ")})`
        : "";
      const isTerrain = msg.styleLabel === "Terrain";
      const licenseNote = isTerrain
        ? "  ·  CC BY-SA 3.0 — credit OpenTopoMap & OSM if publishing"
        : "";
      figma.notify(`Map exported ${w}×${h}${overlayNote}${licenseNote}`, {
        timeout: isTerrain ? 9000 : 4000,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      figma.ui.postMessage({ type: "export-error", error: message });
      figma.notify(`Map export failed: ${message}`, { error: true });
    }
  }
};

// =============================================================================
// Helpers
// =============================================================================

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace(/^#/, "").match(/.{2}/g);
  if (!m || m.length < 3) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[0], 16) / 255,
    g: parseInt(m[1], 16) / 255,
    b: parseInt(m[2], 16) / 255,
  };
}

// SVG-style path data: M to first point, L to each subsequent.
function buildPathData(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  let s = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    s += ` L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`;
  }
  return s;
}

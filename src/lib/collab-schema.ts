// Shared data-only schema declarations. No React, DOM or server-only imports.
import type { BlockConfig } from "@blocknote/core";
export const TONES = ["info", "success", "warning", "danger"] as const;
export const customBlockConfigs = {
Callout: {
    type: "callout",
    propSchema: {
      tone: { default: "info" as string, values: [...TONES] },
    },
    content: "inline",
  },
Expandable: {
    type: "expandable",
    propSchema: {},
    content: "inline",
  },
Step: {
    type: "step",
    propSchema: {},
    content: "inline",
  },
MathBlock: {
    type: "math",
    propSchema: {},
    content: "inline",
  },
Drawio: {
    type: "drawio",
    propSchema: {
      xml: { default: "" },
      src: { default: "" },
    },
    content: "none",
  },
ThemeImage: {
    type: "themeImage",
    propSchema: {
      url: { default: "" },
      darkUrl: { default: "" },
      caption: { default: "" },
    },
    content: "none",
  },
Model3DBlock: {
    type: "model3d",
    propSchema: {
      kind: { default: "architecture" as string },
      title: { default: "" as string },
      source: { default: "preset" as string },
      declaration: { default: "" as string },
      /** For source "data": a CSV/TSV/JSON upload of points. */
      dataUrl: { default: "" as string },
    },
    content: "none",
  },
ApiRequestBlock: {
    type: "apiRequest",
    propSchema: {
      method: { default: "GET" as string },
      path: { default: "/" as string },
      servers: { default: "" as string },
      params: { default: "[]" as string },
      body: { default: "" as string },
      auth: { default: "" as string },
    },
    content: "none",
  },
Sketch: {
    type: "sketch",
    propSchema: {
      scene: { default: "" },
      svg: { default: "" },
    },
    content: "none",
  },
SyncedPage: {
    type: "syncedPage",
    propSchema: {
      pageId: { default: "" },
      title: { default: "" },
    },
    content: "none",
  },
IfVar: {
    type: "ifvar",
    propSchema: {
      name: { default: "audience" },
      equals: { default: "" },
    },
    content: "inline",
  }
} satisfies Record<string, BlockConfig>;
export const noteStyleConfig = { type: "note", propSchema: "string" } as const;

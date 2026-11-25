import type { TypefaceId } from "./typography.ts";

// The default claw theme's UI and chat face. claw's palette lives in base CSS,
// so the service worker's offline shell precaches this family and no theme.
export const DEFAULT_THEME_TYPEFACE = "instrument-sans" satisfies TypefaceId;

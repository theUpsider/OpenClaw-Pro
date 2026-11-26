export const formatSelectedEntry = (entry: string): string =>
  `Selected entry: ${entry}. Rebuild compiled output after source edits.`;

/**
 * Honest completion notice for a reload that replaced registrations without a Gateway
 * restart. The replacement is real for new dispatches, but a call that was already
 * admitted before the reload keeps running its previous generation's code until it
 * finishes (in-flight generation isolation). Without this note a bare "Reloaded"
 * reads as "everything on the host is now the new code", which is what made an
 * already-accepted hook look stale while the reload had in fact succeeded.
 */
export const RELOAD_GENERATION_NOTICE =
  "New dispatches use the reloaded code; calls already accepted before the reload keep their previous generation's code until they finish.";

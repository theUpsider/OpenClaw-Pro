import { expectDefined } from "@openclaw/normalization-core";
import { afterWorkboardUpdate } from "./settle.ts";

/** A button of the open transcript gate, by its visible label. */
export function voiceGateButton(label: "Send" | "Discard"): HTMLButtonElement {
  return expectDefined(
    [...document.querySelectorAll<HTMLButtonElement>(".workboard-voice-gate button")].find(
      (button) => button.textContent === label,
    ),
    `${label} button`,
  );
}

/** Settle the transcript the microphone delivered, then press a gate button. */
export async function pressVoiceGate(label: "Send" | "Discard"): Promise<void> {
  await afterWorkboardUpdate(() => undefined);
  voiceGateButton(label).click();
  await afterWorkboardUpdate(() => undefined);
}

/**
 * Fixed synthetic catalog for the demo-only "Replay a sample message" control.
 *
 * Every name, place and household code below is invented for demonstrations.
 * The server accepts only a catalog `id`; it never accepts message text or
 * files from the request, so this file is the complete set of content a
 * replay can ever inject. Pure data: no I/O, no rendering.
 */

export interface DemoReplayPhoto {
  /** Short description shown to staff; the image itself contains no text. */
  readonly description: string;
  /** Width/height of the rendered synthetic PNG. */
  readonly width: number;
  readonly height: number;
  /** Text-free, face-free SVG drawing rendered server-side to a PNG. */
  readonly svg: string;
}

export interface DemoReplaySample {
  readonly id: string;
  /** Label for the sample picker. */
  readonly label: string;
  /** What the sample demonstrates, for presenters. */
  readonly scenario: string;
  /** The message body, written like a short chat update from a volunteer. */
  readonly text: string;
  readonly photo: DemoReplayPhoto | null;
}

// Boxes, a water jug and a crate drawn from plain shapes: no text, no people.
const suppliesSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160"><rect width="240" height="160" fill="#efe9dc"/><rect x="0" y="122" width="240" height="38" fill="#cdbfa3"/><rect x="22" y="62" width="78" height="62" fill="#d6ab74" stroke="#7f5b3f" stroke-width="3"/><path d="M22 76h78M61 62v62" stroke="#7f5b3f" stroke-width="3"/><rect x="38" y="30" width="52" height="34" fill="#c99a62" stroke="#7f5b3f" stroke-width="3"/><rect x="118" y="52" width="40" height="72" rx="6" fill="#7bb5a4" stroke="#275850" stroke-width="3"/><rect x="128" y="40" width="20" height="14" fill="#275850"/><rect x="172" y="84" width="50" height="40" rx="4" fill="#e2c16b" stroke="#8e7231" stroke-width="3"/><path d="M172 98h50M172 110h50" stroke="#8e7231" stroke-width="2"/></svg>`;

export const demoReplaySamples: readonly DemoReplaySample[] = [
  {
    id: "shared-visit-en",
    label: "Shared food-bank visit (English)",
    scenario:
      "Two volunteers on one visit: the second person still needs identity review.",
    text: "Visited household C-14 with Teodoro today to drop off the food bank box. We were there 60 minutes.",
    photo: null,
  },
  {
    id: "spanish-update",
    label: "Spanish update with a routine need",
    scenario:
      "A Spanish message that reports a non-urgent food need for staff to triage.",
    text: "Hoy entregamos despensas a la familia B-21. Necesitamos más alimentos para el sábado, no es urgente.",
    photo: null,
  },
  {
    id: "unknown-duration",
    label: "Visit with unknown duration",
    scenario: "The time was not tracked, so duration stays unknown, not zero.",
    text: "Visited household A-09 today. I did not track the time.",
    photo: null,
  },
  {
    id: "duplicate-visit",
    label: "Possible duplicate of the shared visit",
    scenario:
      "Repeats the shared visit; staff decide whether it is the same activity.",
    text: "Same visit as my earlier report: visited household C-14 with Teodoro today, 60 minutes.",
    photo: null,
  },
  {
    id: "correction-90",
    label: "Correction from 60 to 90 minutes",
    scenario:
      "A correction whose target contribution must be chosen during review.",
    text: "Correction for my pantry visit today: it was 90 minutes, not 60.",
    photo: null,
  },
  {
    id: "urgent-need",
    label: "Urgent provisional need",
    scenario:
      "An urgent but uncertain alert that stays provisional until staff confirm it.",
    text: "Urgent: the Larkspur Lane shelter may have no food tonight. Please send meals.",
    photo: null,
  },
  {
    id: "supplies-photo",
    label: "Photo of sorted supplies",
    scenario:
      "A synthetic supplies photo; the image establishes neither identity nor hours.",
    text: "Sorted the donated supplies in the photo today.",
    photo: {
      description:
        "Synthetic drawing of boxes, a water jug and a crate. No text, no people.",
      width: 240,
      height: 160,
      svg: suppliesSvg,
    },
  },
  {
    id: "packing-shift",
    label: "Packing shift without a date",
    scenario: "Duration is reported but the date is not, so it stays unknown.",
    text: "Packed 40 grocery kits at the Juniper Street food bank, 90 minutes.",
    photo: null,
  },
];

export const demoReplaySampleIds: readonly string[] = demoReplaySamples.map(
  (sample) => sample.id,
);

export function findDemoReplaySample(id: unknown): DemoReplaySample | null {
  if (typeof id !== "string") return null;
  return demoReplaySamples.find((sample) => sample.id === id) ?? null;
}

/** Picker entries only; message text is never needed to choose a sample. */
export function demoReplayOptions(): Array<{
  id: string;
  label: string;
  scenario: string;
  hasPhoto: boolean;
}> {
  return demoReplaySamples.map((sample) => ({
    id: sample.id,
    label: sample.label,
    scenario: sample.scenario,
    hasPhoto: sample.photo !== null,
  }));
}

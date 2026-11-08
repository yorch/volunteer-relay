import { createHash } from "node:crypto";

/**
 * ElevenLabs narration adapter (server/script only).
 * Endpoint verified against the official API reference:
 * POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps
 * returns `audio_base64` plus character-level alignment arrays.
 */

export const ELEVENLABS_ENDPOINT =
  "https://api.elevenlabs.io/v1/text-to-speech" as const;
export const OUTPUT_FORMAT = "mp3_44100_128" as const;

export interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  speed: number;
}

export const narrationVoiceSettings: VoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
  // 1.10 lifts the read from ~129 wpm to ~142 wpm without sounding rushed;
  // eleven_multilingual_v2 supports 0.7–1.2.
  speed: 1.1,
};

export interface NarrationRequest {
  apiKey: string;
  voiceId: string;
  modelId: string;
  text: string;
  settings?: VoiceSettings;
  pronunciations?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export interface CharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export interface NarrationResult {
  audio: Uint8Array;
  alignment: CharacterAlignment;
  requestId: string | null;
}

/**
 * Cache identity: every input that changes the voice output, including the
 * pronunciation text and settings. Changing one scene never rewrites another.
 */
export function narrationCacheKey(input: {
  text: string;
  provider: string;
  modelId: string;
  voiceId: string;
  settings: VoiceSettings;
  pronunciations: Record<string, string>;
  outputFormat: string;
}): string {
  const payload = {
    schemaVersion: 1,
    text: input.text,
    provider: input.provider,
    modelId: input.modelId,
    voiceId: input.voiceId,
    settings: input.settings,
    pronunciations: Object.entries(input.pronunciations).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
    outputFormat: input.outputFormat,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Rough billable text estimate; the provider bills the submitted characters. */
export function estimateBillableCharacters(
  scenes: ReadonlyArray<{ id: string; narration: string }>,
): { total: number; perScene: Array<{ id: string; characters: number }> } {
  const perScene = scenes.map((scene) => ({
    id: scene.id,
    characters: scene.narration.length,
  }));
  return {
    total: perScene.reduce((sum, scene) => sum + scene.characters, 0),
    perScene,
  };
}

export function parseAlignment(value: unknown): CharacterAlignment {
  const candidate = value as Partial<CharacterAlignment> | null;
  if (
    !candidate ||
    !Array.isArray(candidate.characters) ||
    !Array.isArray(candidate.character_start_times_seconds) ||
    !Array.isArray(candidate.character_end_times_seconds)
  )
    throw new Error("Provider response has no character alignment");
  const characters = candidate.characters;
  const starts = candidate.character_start_times_seconds;
  const ends = candidate.character_end_times_seconds;
  if (characters.length === 0) throw new Error("Alignment is empty");
  if (characters.length !== starts.length || starts.length !== ends.length)
    throw new Error("Alignment arrays are inconsistent");
  for (const [index, character] of characters.entries()) {
    if (typeof character !== "string" || character.length !== 1)
      throw new Error(`Alignment character ${index} is not a single character`);
    const start = starts[index];
    const end = ends[index];
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end < start
    )
      throw new Error(`Alignment timing ${index} is invalid`);
  }
  return {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  };
}

export async function requestNarration(
  input: NarrationRequest,
): Promise<NarrationResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = `${ELEVENLABS_ENDPOINT}/${encodeURIComponent(input.voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": input.apiKey,
      accept: "application/json",
    },
    body: JSON.stringify({
      text: input.text,
      model_id: input.modelId,
      voice_settings: input.settings ?? narrationVoiceSettings,
    }),
  });
  if (!response.ok) {
    // Never echo the request body or headers: they carry the credential.
    throw new Error(
      `ElevenLabs narration failed with HTTP ${response.status}. Check the voice id, model id and account quota.`,
    );
  }
  const payload = (await response.json()) as {
    audio_base64?: unknown;
    alignment?: unknown;
    normalized_alignment?: unknown;
  };
  if (typeof payload.audio_base64 !== "string" || !payload.audio_base64)
    throw new Error("Provider response has no audio");
  const alignment = parseAlignment(
    payload.alignment ?? payload.normalized_alignment,
  );
  return {
    audio: Buffer.from(payload.audio_base64, "base64"),
    alignment,
    requestId: response.headers.get("request-id"),
  };
}

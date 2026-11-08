import { describe, expect, it } from "vitest";
import {
  estimateBillableCharacters,
  narrationCacheKey,
  narrationVoiceSettings,
  parseAlignment,
  requestNarration,
} from "./elevenlabs.ts";

const base = {
  text: "One shared hour means two volunteer-hours.",
  provider: "elevenlabs",
  modelId: "eleven_multilingual_v2",
  voiceId: "voice-a",
  settings: narrationVoiceSettings,
  pronunciations: { Tidepath: "Tide Path" },
  outputFormat: "mp3_44100_128",
};

describe("narration cache identity", () => {
  it("is stable for identical inputs", () => {
    expect(narrationCacheKey(base)).toBe(narrationCacheKey({ ...base }));
  });

  it("changes when any audible input changes", () => {
    const key = narrationCacheKey(base);
    expect(narrationCacheKey({ ...base, text: `${base.text} ` })).not.toBe(key);
    expect(narrationCacheKey({ ...base, voiceId: "voice-b" })).not.toBe(key);
    expect(narrationCacheKey({ ...base, modelId: "other-model" })).not.toBe(
      key,
    );
    expect(
      narrationCacheKey({ ...base, pronunciations: { Tidepath: "Tidepath" } }),
    ).not.toBe(key);
    expect(
      narrationCacheKey({
        ...base,
        settings: { ...narrationVoiceSettings, speed: 1.05 },
      }),
    ).not.toBe(key);
  });

  it("is insensitive to pronunciation ordering", () => {
    expect(
      narrationCacheKey({
        ...base,
        pronunciations: { Tidepath: "Tide Path", Sofia: "So-fee-ah" },
      }),
    ).toBe(
      narrationCacheKey({
        ...base,
        pronunciations: { Sofia: "So-fee-ah", Tidepath: "Tide Path" },
      }),
    );
  });
});

describe("billing estimate", () => {
  it("reports characters per scene and in total", () => {
    const estimate = estimateBillableCharacters([
      { id: "S01", narration: "abc" },
      { id: "S02", narration: "defg" },
    ]);
    expect(estimate.perScene).toEqual([
      { id: "S01", characters: 3 },
      { id: "S02", characters: 4 },
    ]);
    expect(estimate.total).toBe(7);
  });
});

describe("alignment parsing", () => {
  const good = {
    characters: ["H", "i"],
    character_start_times_seconds: [0, 0.05],
    character_end_times_seconds: [0.05, 0.1],
  };

  it("accepts a well-formed alignment", () => {
    expect(parseAlignment(good).characters).toEqual(["H", "i"]);
  });

  it("rejects malformed or missing alignment", () => {
    expect(() => parseAlignment(null)).toThrow(/no character alignment/);
    expect(() =>
      parseAlignment({ ...good, character_end_times_seconds: [0.05] }),
    ).toThrow(/inconsistent/);
    expect(() =>
      parseAlignment({
        characters: ["ab"],
        character_start_times_seconds: [0],
        character_end_times_seconds: [0.1],
      }),
    ).toThrow(/single character/);
    expect(() =>
      parseAlignment({
        characters: ["a"],
        character_start_times_seconds: [0.2],
        character_end_times_seconds: [0.1],
      }),
    ).toThrow(/timing .* is invalid/);
  });
});

describe("provider request", () => {
  it("never leaks the key into errors and validates the response", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ audio_base64: "AA==", alignment: null }), {
        status: 401,
      })) as unknown as typeof fetch;
    await expect(
      requestNarration({
        apiKey: "secret-key",
        voiceId: "v",
        modelId: "m",
        text: "hello",
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("returns audio bytes and alignment for a successful response", async () => {
    const payload = {
      audio_base64: Buffer.from("audio").toString("base64"),
      alignment: {
        characters: ["h", "i"],
        character_start_times_seconds: [0, 0.1],
        character_end_times_seconds: [0.1, 0.2],
      },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "request-id": "req-1" },
      })) as unknown as typeof fetch;
    const result = await requestNarration({
      apiKey: "secret-key",
      voiceId: "v",
      modelId: "m",
      text: "hi",
      fetchImpl,
    });
    expect(Buffer.from(result.audio).toString()).toBe("audio");
    expect(result.requestId).toBe("req-1");
    expect(result.alignment.character_end_times_seconds).toEqual([0.1, 0.2]);
  });
});

import { sourceEnvelopeSchema } from "@relay/contracts";
import { describe, expect, it, vi } from "vitest";
import { sources } from "../../../fixtures/sources.ts";
import { createOpenAIProvider } from "./openai.ts";

const source = sourceEnvelopeSchema.parse(sources[0]);
const versions = {
  model: "configured-model",
  prompt: "v1",
  policy: "review-all",
};
describe("OpenAI structured extraction transport", () => {
  it("uses fixed endpoint, schema and untrusted evidence without tools", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "completed",
        output: [
          {
            content: [
              { type: "output_text", text: '{"items":[],"unresolved":[]}' },
            ],
          },
        ],
      }),
    );
    const provider = createOpenAIProvider({
      apiKey: "synthetic",
      fetch: request,
    });
    expect(await provider.extract({ source, versions })).toEqual({
      items: [],
      unresolved: [],
    });
    const call = request.mock.calls[0];
    if (!call) throw new Error("Expected provider request");
    expect(call[0]).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(call[1]?.body));
    expect(body.text.format.type).toBe("json_schema");
    expect(body.store).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.instructions).toContain("untrusted");
  });
  it("classifies provider outage as retryable but incomplete output as permanent", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ status: "incomplete", output: [] }),
      );
    const provider = createOpenAIProvider({
      apiKey: "synthetic",
      fetch: request,
    });
    await expect(provider.extract({ source, versions })).rejects.toMatchObject({
      retryable: true,
    });
    await expect(provider.extract({ source, versions })).rejects.toMatchObject({
      retryable: false,
    });
  });
});

it("never calls the provider without a durable reservation and reports billed usage", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      status: "completed",
      usage: { input_tokens: 123, output_tokens: 45 },
      output: [
        {
          content: [
            { type: "output_text", text: '{"items":[],"unresolved":[]}' },
          ],
        },
      ],
    }),
  );
  const denied = createOpenAIProvider({
    apiKey: "synthetic",
    fetch: request,
    beforeRequest: async () => {
      throw new Error("Budget exhausted");
    },
  });
  await expect(denied.extract({ source, versions })).rejects.toThrow(
    "Budget exhausted",
  );
  expect(request).not.toHaveBeenCalled();
  const usage = vi.fn(async () => {});
  const provider = createOpenAIProvider({
    apiKey: "synthetic",
    fetch: request,
    beforeRequest: async () => {},
    onUsage: usage,
  });
  await provider.extract({ source, versions });
  expect(usage).toHaveBeenCalledWith({ inputTokens: 123, outputTokens: 45 });
});

it("refuses input exceeding the reservation before marking sent or making a request", async () => {
  const request = vi.fn<typeof fetch>();
  const sent = vi.fn(async () => {});
  const provider = createOpenAIProvider({
    apiKey: "synthetic",
    fetch: request,
    maxInputTokens: 1,
    beforeRequest: sent,
  });
  await expect(provider.extract({ source, versions })).rejects.toMatchObject({
    retryable: false,
  });
  expect(sent).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

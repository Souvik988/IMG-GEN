import { afterEach, describe, expect, it, vi } from "vitest";
import { openRouterGenerateImage } from "./openrouter";
import { ProviderError } from "./types";
import type { GenerateImageInput } from "./types";

const baseInput: GenerateImageInput = {
  references: [{ data: Buffer.from("ref"), mimeType: "image/png" }],
  prompt: "a saree on a model",
  resolution: "2k",
  aspectRatio: "portrait",
  count: 1,
  model: { id: "model-id", provider: "openrouter", modelId: "some/model", role: "image_generator" },
  timeoutMs: 30_000,
};

function imagesResponse(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("openRouterGenerateImage", () => {
  it("rejects when no API key is configured, without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(openRouterGenerateImage(baseInput, "")).rejects.toMatchObject({
      name: "ProviderError",
    } satisfies Partial<ProviderError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("upgrades seedream-4.5 from 1k to 2K (below its pixel minimum otherwise)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      imagesResponse({ data: [{ b64_json: Buffer.from("img").toString("base64"), media_type: "image/png" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await openRouterGenerateImage(
      { ...baseInput, resolution: "1k", model: { ...baseInput.model, modelId: "bytedance-seed/seedream-4.5" } },
      "test-key",
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.resolution).toBe("2K");
  });

  it("does not force other models off their requested 1K resolution", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      imagesResponse({ data: [{ b64_json: Buffer.from("img").toString("base64") }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await openRouterGenerateImage({ ...baseInput, resolution: "1k" }, "test-key");

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.resolution).toBe("1K");
  });

  it("includes character reference photos alongside garment references in input_references", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      imagesResponse({ data: [{ b64_json: Buffer.from("img").toString("base64") }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await openRouterGenerateImage(
      {
        ...baseInput,
        characterReferences: [
          { data: Buffer.from("front"), mimeType: "image/jpeg" },
          { data: Buffer.from("three-quarter"), mimeType: "image/jpeg" },
        ],
      },
      "test-key",
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.input_references).toHaveLength(3);
  });

  it("clamps count to the provider's 1-10 range", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      imagesResponse({ data: [{ b64_json: Buffer.from("img").toString("base64") }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await openRouterGenerateImage({ ...baseInput, count: 99 }, "test-key");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).n).toBe(10);

    await openRouterGenerateImage({ ...baseInput, count: 0 }, "test-key");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).n).toBe(1);
  });

  it("downloads image bytes by URL when the response has no inline b64_json", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(imagesResponse({ data: [{ url: "https://cdn.example/img.png" }] }))
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/webp" }),
        arrayBuffer: async () => new TextEncoder().encode("downloaded").buffer,
      } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await openRouterGenerateImage(baseInput, "test-key");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://cdn.example/img.png");
    expect(result.images[0]).toMatchObject({ mimeType: "image/webp" });
  });

  it("throws when the provider returns no image data at all", async () => {
    const fetchMock = vi.fn().mockResolvedValue(imagesResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(openRouterGenerateImage(baseInput, "test-key")).rejects.toMatchObject({
      name: "ProviderError",
    } satisfies Partial<ProviderError>);
  });

  it("maps usage and provider-reported cost from the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      imagesResponse({
        data: [{ b64_json: Buffer.from("img").toString("base64") }],
        usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0.04 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await openRouterGenerateImage(baseInput, "test-key");

    expect(result.usage).toMatchObject({
      inputTokens: 50,
      outputTokens: 10,
      imageCount: 1,
      resolution: "2k",
      providerReportedCostUsd: 0.04,
    });
  });

  it("surfaces a ProviderError with the HTTP status on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => "insufficient credits",
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(openRouterGenerateImage(baseInput, "test-key")).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("402"),
    } satisfies Partial<ProviderError>);
  });
});

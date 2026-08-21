import { afterEach, describe, expect, it, vi } from "vitest";
import { openRouterChatJson } from "./openrouter";
import { ProviderError } from "./types";

const schema = {
  parse(value: unknown) {
    if (!value || typeof value !== "object" || (value as { ok?: unknown }).ok !== true) {
      throw new Error("missing ok");
    }
    return value as { ok: true };
  },
  safeParse() {
    return { success: false as const };
  },
};

const input = {
  systemPrompt: "test",
  userPrompt: "test",
  schema,
  jsonSchema: { type: "object" },
  model: { id: "model-id", provider: "openrouter" as const, modelId: "model", role: "review" },
  timeoutMs: 1_000,
};

function response(content: string, inputTokens: number, outputTokens: number, cost: number) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, cost },
    }),
  } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("openRouterChatJson accounting", () => {
  it("includes the repair call in successful structured-output usage", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response("{}", 10, 2, 0.001))
      .mockResolvedValueOnce(response('{"ok":true}', 20, 3, 0.002));
    vi.stubGlobal("fetch", fetchMock);

    const result = await openRouterChatJson(input, "test-key");

    expect(result.usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 5,
      providerReportedCostUsd: 0.003,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      max_tokens: 4096,
    });
  });

  it("uses a stage-specific output ceiling", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response('{"ok":true}', 10, 2, 0.001));
    vi.stubGlobal("fetch", fetchMock);

    await openRouterChatJson({ ...input, maxTokens: 1_200 }, "test-key");

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      max_tokens: 1200,
    });
  });

  it("can request compact JSON without hidden reasoning for image review", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response('{"ok":true}', 10, 2, 0.001));
    vi.stubGlobal("fetch", fetchMock);

    await openRouterChatJson(
      { ...input, maxTokens: 1_200, strictSchema: false, disableReasoning: true },
      "test-key",
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      response_format: { type: "json_object" },
      reasoning: { effort: "none", exclude: true },
    });
  });

  it("returns cumulative billable usage when both structured-output responses are invalid", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response("{}", 10, 2, 0.001))
      .mockResolvedValueOnce(response("{}", 20, 3, 0.002)));

    await expect(openRouterChatJson(input, "test-key")).rejects.toMatchObject({
      name: "ProviderError",
      usage: {
        inputTokens: 30,
        outputTokens: 5,
        providerReportedCostUsd: 0.003,
      },
    } satisfies Partial<ProviderError>);
  });
});

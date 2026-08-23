import {
  ProviderError,
  type ChatJsonInput,
  type GenerateImageInput,
  type GenerateImageOutput,
  type ImageInput,
  type ProviderResult,
} from "./types";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function toDataUri(image: ImageInput): string {
  return `data:${image.mimeType};base64,${image.data.toString("base64")}`;
}

function buildUserContent(text: string, images: ImageInput[]): ContentPart[] {
  const parts: ContentPart[] = [{ type: "text", text }];
  for (const img of images) {
    parts.push({ type: "image_url", image_url: { url: toDataUri(img) } });
  }
  return parts;
}

/**
 * Repairs the single most common way LLM JSON output breaks: a string value
 * (often a free-text array element) contains a literal, unescaped `"`
 * instead of `\"`. A raw `"` inside a string terminates it early, and
 * whatever follows the "real" closing quote reads as a syntax error
 * (typically "Expected ',' or ']'/'}' after ..."). Re-scans the text
 * tracking string/escape state; a `"` encountered mid-string is only
 * treated as a real closing quote when the next non-whitespace character is
 * a JSON structural delimiter (`,` `}` `]` `:`) or end of input — otherwise
 * it's escaped and the string continues.
 */
function repairUnescapedQuotes(json: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (!inString) {
      result += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j])) j++;
      const next = json[j];
      const isRealClose = next === undefined || ",}]:".includes(next);
      if (isRealClose) {
        result += ch;
        inString = false;
      } else {
        result += '\\"';
      }
      continue;
    }
    result += ch;
  }
  return result;
}

/** Extract the first JSON object from model text (handles code fences / prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new ProviderError("No JSON object found in model output", "openrouter");
  }
  const raw = candidate.slice(start, end + 1);
  try {
    return JSON.parse(raw);
  } catch (err) {
    try {
      return JSON.parse(repairUnescapedQuotes(raw));
    } catch {
      throw err;
    }
  }
}

type OpenRouterResponse = {
  choices: Array<{ message: { content: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
};

type OpenRouterImageResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
    media_type?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
};

async function callOpenRouter(
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<OpenRouterResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://shotlin.local",
        "X-Title": "Shotlin MVP",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        `OpenRouter HTTP ${res.status}: ${text.slice(0, 400)}`,
        "openrouter",
      );
    }
    return (await res.json()) as OpenRouterResponse;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(
      `OpenRouter request failed: ${(err as Error).message}`,
      "openrouter",
      err,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenRouterImages(
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<OpenRouterImageResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/images", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://shotlin.local",
        "X-Title": "Shotlin MVP",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        `OpenRouter image HTTP ${res.status}: ${text.slice(0, 400)}`,
        "openrouter",
      );
    }
    return (await res.json()) as OpenRouterImageResponse;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(
      `OpenRouter image request failed: ${(err as Error).message}`,
      "openrouter",
      err,
    );
  } finally {
    clearTimeout(timer);
  }
}

function imageDataUri(image: ImageInput): string {
  return `data:${image.mimeType};base64,${image.data.toString("base64")}`;
}

async function readGeneratedImage(
  image: NonNullable<OpenRouterImageResponse["data"]>[number],
): Promise<ImageInput> {
  if (image.b64_json) {
    return {
      data: Buffer.from(image.b64_json, "base64"),
      mimeType: image.media_type ?? "image/png",
    };
  }
  if (image.url) {
    const response = await fetch(image.url);
    if (!response.ok) {
      throw new ProviderError(
        `OpenRouter image download failed with HTTP ${response.status}`,
        "openrouter",
      );
    }
    return {
      data: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") ?? image.media_type ?? "image/png",
    };
  }
  throw new ProviderError("OpenRouter returned an image without data", "openrouter");
}

/**
 * Generic OpenRouter JSON-chat call with schema validation and one repair retry.
 */
export async function openRouterChatJson<T>(
  input: ChatJsonInput<T>,
  apiKey: string,
): Promise<ProviderResult<T>> {
  if (!apiKey) {
    throw new ProviderError("OPENROUTER_API_KEY is not configured", "openrouter");
  }

  const useStrictSchema = input.jsonSchema && input.strictSchema !== false;
  const schemaInstruction = input.jsonSchema && !useStrictSchema
    ? `\n\nReturn ONLY a complete JSON object matching this exact schema. Do not include reasoning, markdown, or an empty object:\n${JSON.stringify(input.jsonSchema)}`
    : "";
  const messages = [
    { role: "system" as const, content: input.systemPrompt },
    {
      role: "user" as const,
      content: buildUserContent(
        `${input.userPrompt || "Analyze the provided images and respond with the required JSON."}${schemaInstruction}`,
        input.images ?? [],
      ),
    },
  ];

  const makeBody = (extra?: string, relaxedJson = false) => ({
    model: input.model.modelId,
    messages: extra
      ? [
          ...messages,
          { role: "assistant" as const, content: "…" },
          {
            role: "user" as const,
            content: `${extra}${relaxedJson && input.jsonSchema ? `\n\nReturn a complete object matching this exact JSON schema. Do not return an empty object:\n${JSON.stringify(input.jsonSchema)}` : ""}`,
          },
        ]
      : messages,
    temperature: 0.1,
    max_tokens: input.maxTokens ?? 4096,
    response_format: useStrictSchema && !relaxedJson
      ? {
          type: "json_schema" as const,
          json_schema: {
            name: input.schemaName ?? "shotlin_response",
            strict: true,
            schema: input.jsonSchema,
          },
        }
      : { type: "json_object" as const },
    provider: useStrictSchema && !relaxedJson ? { require_parameters: true } : undefined,
    reasoning: input.disableReasoning ? { effort: "none", exclude: true } : undefined,
  });

  const totalUsage = {
    inputTokens: 0,
    outputTokens: 0,
    imageCount: 0,
    providerReportedCostUsd: null as number | null,
  };
  let lastError = "";
  let lastContent = "";
  for (let attemptIdx = 0; attemptIdx < 2; attemptIdx++) {
    const body = makeBody(
      attemptIdx === 0
        ? undefined
        : `Your previous output was invalid: ${lastError}. Return ONLY the required valid JSON object.`,
      attemptIdx === 1,
    );

    const res = await callOpenRouter(apiKey, body, input.timeoutMs);
    const content = res.choices?.[0]?.message?.content ?? "";
    lastContent = content;
    totalUsage.inputTokens += res.usage?.prompt_tokens ?? 0;
    totalUsage.outputTokens += res.usage?.completion_tokens ?? 0;
    if (res.usage?.cost != null) {
      totalUsage.providerReportedCostUsd =
        (totalUsage.providerReportedCostUsd ?? 0) + res.usage.cost;
    }

    try {
      const parsed = extractJson(content);
      const validated = input.schema.parse(parsed);
      return {
        data: validated,
        usage: totalUsage,
        raw: content,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attemptIdx === 1) {
        throw new ProviderError(
          `OpenRouter output failed schema validation twice: ${lastError}`,
          "openrouter",
          undefined,
          totalUsage,
          lastContent.slice(0, 1_000),
        );
      }
    }
  }

  throw new ProviderError(
    "OpenRouter chatJson exhausted retries",
    "openrouter",
    undefined,
    totalUsage,
    lastContent.slice(0, 1_000),
  );
}

/**
 * OpenRouter dedicated image endpoint. Reference images are sent as private
 * base64 data URLs so the provider can perform image-to-image generation
 * without requiring public object-storage URLs.
 */
export async function openRouterGenerateImage(
  input: GenerateImageInput,
  apiKey: string,
): Promise<GenerateImageOutput> {
  if (!apiKey) {
    throw new ProviderError("OPENROUTER_API_KEY is not configured", "openrouter");
  }

  const aspectRatio: Record<string, string> = {
    portrait: "3:4",
    square: "1:1",
    landscape: "4:3",
  };
  const resolution: Record<string, string> = {
    "1k": "1K",
    "2k": "2K",
    "4k": "4K",
  };
  // Seedream 4.5 rejects 1K requests below its 3,686,400-pixel minimum. Its
  // compatibility floor must not be applied to Nano Banana 2, which supports
  // the product's normal 1K, 2K, and 4K output selections.
  const requestedResolution = input.model.modelId === "bytedance-seed/seedream-4.5" && input.resolution === "1k"
    ? "2K"
    : resolution[input.resolution] ?? "1K";
  const references = [...input.references, ...(input.characterReferences ?? [])];
  const response = await callOpenRouterImages(
    apiKey,
    {
      model: input.model.modelId,
      prompt: input.prompt,
      n: Math.min(Math.max(input.count, 1), 10),
      resolution: requestedResolution,
      aspect_ratio: aspectRatio[input.aspectRatio] ?? "3:4",
      output_format: "png",
      input_references: references.map((image) => ({
        type: "image_url",
        image_url: { url: imageDataUri(image) },
      })),
    },
    input.timeoutMs,
  );

  const images = await Promise.all((response.data ?? []).map(readGeneratedImage));
  if (images.length === 0) {
    throw new ProviderError("OpenRouter returned no generated image", "openrouter");
  }

  return {
    images,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? response.usage?.total_tokens ?? 0,
      imageCount: images.length,
      resolution: input.resolution,
      providerReportedCostUsd: response.usage?.cost ?? null,
    },
  };
}

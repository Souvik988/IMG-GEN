import { describe, expect, it } from "vitest";
import { extractJson } from "./openrouter";

describe("extractJson", () => {
  it("parses clean JSON unchanged", () => {
    expect(extractJson('{"a": 1, "b": ["x", "y"]}')).toEqual({ a: 1, b: ["x", "y"] });
  });

  it("strips markdown code fences", () => {
    expect(extractJson('Here you go:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("repairs an unescaped quote inside a string array element (the real failure signature)", () => {
    // Reproduces the exact live failure: a vision model's free-text array
    // element contains a literal " instead of \", which otherwise throws
    // "Expected ',' or ']' after array element".
    const raw = '{"uncertainDetails": ["the tag reads "raw silk" on the hem", "sheen is uncertain"]}';
    expect(extractJson(raw)).toEqual({
      uncertainDetails: ['the tag reads "raw silk" on the hem', "sheen is uncertain"],
    });
  });

  it("repairs an unescaped quote inside an object string value", () => {
    const raw = '{"note": "described as "hand-embroidered" pallu", "confidence": 80}';
    expect(extractJson(raw)).toEqual({
      note: 'described as "hand-embroidered" pallu',
      confidence: 80,
    });
  });

  it("does not corrupt properly escaped quotes", () => {
    const raw = '{"note": "already \\"escaped\\" correctly"}';
    expect(extractJson(raw)).toEqual({ note: 'already "escaped" correctly' });
  });

  it("still throws a useful error for genuinely truncated JSON", () => {
    expect(() => extractJson('{"a": ["x", "y"')).toThrow();
  });

  it("throws when no JSON object is present at all", () => {
    expect(() => extractJson("no json here")).toThrow("No JSON object found in model output");
  });
});

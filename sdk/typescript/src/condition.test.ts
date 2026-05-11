import { describe, expect, it } from "vitest";
import { evaluate } from "./condition.js";
import { parseCondition } from "./parser.js";
import { parseDocument } from "yaml";

function cond(yaml: string) {
  // Wrap in a fake `condition:` field so we can reuse the parser.
  const doc = parseDocument(yaml);
  return parseCondition(doc.contents, "test");
}

describe("condition evaluator (parity with Go)", () => {
  const payload = {
    count: 3,
    tier: "premium",
    items: [1, 2, 3],
    nested: { otherCounter: 4 },
    flag: true,
  };

  it("eq path-literal-string-match", () => {
    expect(evaluate(cond(`- eq:\n    - tier\n    - "premium"\n`), payload)).toBe(true);
  });
  it("eq path-literal-string-mismatch", () => {
    expect(evaluate(cond(`- eq:\n    - tier\n    - "standard"\n`), payload)).toBe(false);
  });
  it("eq path-path", () => {
    // count=3, otherCounter=4 → not equal
    expect(evaluate(cond(`- eq:\n    - count\n    - nested.otherCounter\n`), payload)).toBe(false);
  });
  it("eq numeric-coerce", () => {
    expect(evaluate(cond(`- eq:\n    - count\n    - 3\n`), payload)).toBe(true);
  });
  it("eq numeric-string-coerce (loose equality)", () => {
    // "3" coerces to 3 in comparison with number 3
    expect(evaluate(cond(`- eq:\n    - count\n    - "3"\n`), payload)).toBe(true);
  });
  it("gt", () => {
    expect(evaluate(cond(`- gt:\n    - count\n    - 2\n`), payload)).toBe(true);
    expect(evaluate(cond(`- gt:\n    - count\n    - 5\n`), payload)).toBe(false);
  });
  it("lte", () => {
    expect(evaluate(cond(`- lte:\n    - count\n    - 3\n`), payload)).toBe(true);
  });
  it("neq", () => {
    expect(evaluate(cond(`- neq:\n    - tier\n    - "standard"\n`), payload)).toBe(true);
  });

  it("nested len + eq", () => {
    expect(
      evaluate(cond(`- eq:\n    - len:\n        - items\n    - 3\n`), payload),
    ).toBe(true);
  });
  it("nested len + gt", () => {
    expect(
      evaluate(cond(`- gt:\n    - len:\n        - items\n    - 1\n`), payload),
    ).toBe(true);
  });

  it("and both true", () => {
    expect(
      evaluate(
        cond(`- and:\n    - eq: [tier, "premium"]\n    - gt: [count, 0]\n`),
        payload,
      ),
    ).toBe(true);
  });
  it("and one false", () => {
    expect(
      evaluate(
        cond(`- and:\n    - eq: [tier, "premium"]\n    - gt: [count, 100]\n`),
        payload,
      ),
    ).toBe(false);
  });
  it("or one true", () => {
    expect(
      evaluate(
        cond(`- or:\n    - eq: [tier, "standard"]\n    - gt: [count, 0]\n`),
        payload,
      ),
    ).toBe(true);
  });
  it("not flips", () => {
    expect(
      evaluate(cond(`- not:\n    - eq: [tier, "standard"]\n`), payload),
    ).toBe(true);
  });

  it("top-level OR: first true", () => {
    expect(
      evaluate(
        cond(`- eq: [tier, "premium"]\n- eq: [tier, "standard"]\n`),
        payload,
      ),
    ).toBe(true);
  });
  it("top-level OR: second true", () => {
    expect(
      evaluate(
        cond(`- eq: [tier, "gold"]\n- eq: [tier, "premium"]\n`),
        payload,
      ),
    ).toBe(true);
  });
  it("top-level OR: all false", () => {
    expect(
      evaluate(cond(`- eq: [tier, "gold"]\n- eq: [tier, "silver"]\n`), payload),
    ).toBe(false);
  });

  it("exists present / missing", () => {
    expect(evaluate(cond(`- exists:\n    - tier\n`), payload)).toBe(true);
    expect(evaluate(cond(`- exists:\n    - missing.field\n`), payload)).toBe(false);
  });

  it("path style distinction: plain vs quoted", () => {
    // Plain `count` resolves to payload.count (5)
    const p = { count: 5 };
    expect(evaluate(cond(`- eq:\n    - count\n    - 5\n`), p)).toBe(true);
    // Quoted "count" is the literal string "count", which != 5
    expect(evaluate(cond(`- eq:\n    - "count"\n    - 5\n`), p)).toBe(false);
  });

  it("empty condition is true", () => {
    expect(evaluate(cond(`[]\n`), payload)).toBe(true);
  });
});

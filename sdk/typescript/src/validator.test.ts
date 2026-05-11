import { describe, expect, it } from "vitest";
import { validate, ValidationError } from "./validator.js";
import type { WorkflowDef } from "./types.js";

function assertOK(wf: WorkflowDef, initialFields?: string[]): void {
  expect(() => validate(wf, initialFields ? { initialFields } : {})).not.toThrow();
}

function assertFails(
  wf: WorkflowDef,
  match: string | RegExp,
  initialFields?: string[],
): void {
  try {
    validate(wf, initialFields ? { initialFields } : {});
    throw new Error("expected validation to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    const errors = (err as ValidationError).errors.join("\n");
    if (typeof match === "string") {
      expect(errors).toContain(match);
    } else {
      expect(errors).toMatch(match);
    }
  }
}

describe("validator (parity with Go)", () => {
  it("accepts a linear chain", () => {
    assertOK({
      id: "ok",
      start: "a",
      nodes: [
        { id: "a", type: "enhancer", next_node: "b" },
        { id: "b", type: "action" },
      ],
    });
  });

  it("detects cycles", () => {
    assertFails(
      {
        id: "bad",
        start: "a",
        nodes: [
          { id: "a", type: "enhancer", next_node: "b" },
          { id: "b", type: "enhancer", next_node: "a" },
        ],
      },
      "cycle detected",
    );
  });

  it("detects merges (in-degree > 1)", () => {
    assertFails(
      {
        id: "merge",
        start: "f",
        nodes: [
          {
            id: "f",
            type: "filter",
            branches: [
              { label: "a", next_node: "c" },
              { label: "b", next_node: "c" },
            ],
          },
          { id: "c", type: "action" },
        ],
      },
      'in-degree 2',
    );
  });

  it("detects undefined references", () => {
    assertFails(
      {
        id: "ref",
        start: "a",
        nodes: [{ id: "a", type: "enhancer", next_node: "ghost" }],
      },
      'references undefined node "ghost"',
    );
  });

  it("detects unreachable nodes", () => {
    assertFails(
      {
        id: "unreach",
        start: "a",
        nodes: [
          { id: "a", type: "action" },
          { id: "orphan", type: "action" },
        ],
      },
      "unreachable",
    );
  });

  it("detects missing data-flow field", () => {
    assertFails(
      {
        id: "df",
        start: "a",
        nodes: [
          {
            id: "a",
            type: "enhancer",
            next_node: "b",
            schema: { reads: ["in"], produces: ["validated"] },
          },
          {
            id: "b",
            type: "action",
            schema: { reads: ["email_address"] },
          },
        ],
      },
      'reads field "email_address"',
      ["in"],
    );
  });

  it("data-flow: schema-less node is opaque", () => {
    assertOK(
      {
        id: "ok",
        start: "a",
        nodes: [
          { id: "a", type: "enhancer", next_node: "b" }, // no schema
          { id: "b", type: "action", schema: { reads: ["in"] } },
        ],
      },
      ["in"],
    );
  });

  it("data-flow: branch can't see sibling outputs", () => {
    assertFails(
      {
        id: "iso",
        start: "f",
        nodes: [
          {
            id: "f",
            type: "filter",
            branches: [
              { label: "a", next_node: "left" },
              { label: "b", next_node: "right" },
            ],
          },
          {
            id: "left",
            type: "enhancer",
            schema: { produces: ["left_field"] },
          },
          {
            id: "right",
            type: "action",
            schema: { reads: ["left_field"] },
          },
        ],
      },
      'reads field "left_field"',
      [],
    );
  });
});

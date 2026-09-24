/**
 * The JSON Schema subset the `uno-work` tools declare, and a validator for it.
 *
 * Each tool's `inputSchema` is the one source of truth: the model reads it in
 * `tools/list`, and the daemon validates arguments against the very same
 * object before running anything — they can't drift apart.
 *
 * Supported: object (properties, required, additionalProperties: false),
 * string (enum, minLength, maxLength, pattern), integer / number (minimum,
 * maximum), boolean, array (items), and `oneOf`-free unions via `type: [..]`
 * are deliberately not supported — keep tool inputs flat and obvious.
 */

export type JsonSchema =
  | {
      readonly type: "object";
      readonly description?: string;
      readonly properties: Readonly<Record<string, JsonSchema>>;
      readonly required?: ReadonlyArray<string>;
      readonly additionalProperties: false;
    }
  | {
      readonly type: "string";
      readonly description?: string;
      readonly enum?: ReadonlyArray<string>;
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly pattern?: string;
    }
  | {
      readonly type: "integer" | "number";
      readonly description?: string;
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | { readonly type: "boolean"; readonly description?: string }
  | {
      readonly type: "array";
      readonly description?: string;
      readonly items: JsonSchema;
      readonly maxItems?: number;
    };

export type ObjectSchema = Extract<JsonSchema, { type: "object" }>;

/** Returns the first problem as a sentence the model can act on, or null. */
export function validateArgs(schema: JsonSchema, value: unknown, at = "arguments"): string | null {
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `${at} must be an object.`;
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (record[key] === undefined || record[key] === null) {
          return `${at}.${key} is required.`;
        }
      }
      for (const [key, entry] of Object.entries(record)) {
        const propertySchema = schema.properties[key];
        if (propertySchema === undefined) {
          return `${at}.${key} is not a known field (allowed: ${Object.keys(schema.properties).join(", ") || "none"}).`;
        }
        if (entry === undefined || entry === null) continue;
        const problem = validateArgs(propertySchema, entry, `${at}.${key}`);
        if (problem !== null) return problem;
      }
      return null;
    }
    case "string": {
      if (typeof value !== "string") return `${at} must be a string.`;
      if (schema.enum && !schema.enum.includes(value)) {
        return `${at} must be one of: ${schema.enum.join(", ")}.`;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `${at} must be at least ${schema.minLength} characters.`;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${at} must be at most ${schema.maxLength} characters.`;
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
        return `${at} must match ${schema.pattern}.`;
      }
      return null;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${at} must be a number.`;
      if (schema.type === "integer" && !Number.isInteger(value)) {
        return `${at} must be a whole number.`;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `${at} must be at least ${schema.minimum}.`;
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `${at} must be at most ${schema.maximum}.`;
      }
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : `${at} must be true or false.`;
    case "array": {
      if (!Array.isArray(value)) return `${at} must be an array.`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${at} must have at most ${schema.maxItems} items.`;
      }
      for (const [index, entry] of value.entries()) {
        const problem = validateArgs(schema.items, entry, `${at}[${index}]`);
        if (problem !== null) return problem;
      }
      return null;
    }
  }
}

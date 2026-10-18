// Canonical JSON for hashing: keys sorted lexicographically at every depth, no whitespace,
// UTF-8 text taken as-is (no Unicode normalization), line breaks inside strings escaped by
// JSON.stringify so the output never contains a raw CR or LF. The same value therefore
// hashes identically on Windows, macOS and Linux.

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encode(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`unsupported number ${String(value)} at ${path}: not canonical`);
      }
      return JSON.stringify(value);
    case "object":
      return encodeObject(value, path, seen);
    default:
      throw new TypeError(`unsupported ${typeof value} at ${path}: not canonical`);
  }
}

function encodeObject(value: object, path: string, seen: Set<object>): string {
  if (seen.has(value)) throw new TypeError(`circular structure at ${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => encode(item, `${path}[${index}]`, seen)).join(",")}]`;
    }
    if (!isPlainObject(value)) {
      throw new TypeError(`unsupported object type at ${path}: not canonical`);
    }
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(record[key], `${path}.${key}`, seen)}`);
    return `{${members.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, "$", new Set());
}

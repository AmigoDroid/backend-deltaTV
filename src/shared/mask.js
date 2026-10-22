const SENSITIVE = /(pass(word)?|token|secret|credential|authorization|cookie|^code$|licensecode|partnercode|refresh|url)/i;

export function maskDeep(value, depth = 0) {
  if (depth > 5 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? "[REDACTED]" : maskDeep(v, depth + 1)]),
  );
}

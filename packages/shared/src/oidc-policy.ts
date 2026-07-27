export function oidcAuthenticationContextSatisfied(
  payload: Record<string, unknown>,
  required: string,
): boolean {
  const expected = required.split(',').map((value) => value.trim()).filter(Boolean);
  if (!expected.length) return true;
  const amr = Array.isArray(payload.amr) ? payload.amr.filter((value): value is string => typeof value === 'string') : [];
  const acr = typeof payload.acr === 'string' ? [payload.acr] : [];
  const contexts = new Set([...amr, ...acr]);
  return expected.every((value) => contexts.has(value));
}

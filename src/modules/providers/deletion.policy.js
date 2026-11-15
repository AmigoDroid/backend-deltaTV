/** Políticas puras para validar exclusões sem depender do banco. */
export const exactConfirmation = (value, expected) =>
  typeof value === 'string' && value.trim() === String(expected);
export const requiresReplacementOrExplicitRisk = (liveActivations, replacementId, force) =>
  Number(liveActivations) > 0 && !replacementId && force !== true;

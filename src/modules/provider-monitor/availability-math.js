export function percent(ok, all) {
  if (!all) return null;
  return Math.round((10000 * Number(ok)) / Number(all)) / 100;
}

export function classifyQuality(row) {
  const sampled = Number(row.sampleDevices)||0;
  const affected = Number(row.affectedDevices)||0;
  const ratio = sampled ? affected / sampled : 0;
  // Mínimo de TVs independentes; uma origem ruim de cliente isolado não causa alarme coletivo.
  const alert = sampled >= 10 && affected >= 5 && ratio >= 0.30;
  return { ...row, sampleDevices:sampled,affectedDevices:affected,
    sampleEvents:Number(row.sampleEvents)||0,errorEvents:Number(row.errorEvents)||0,
    bufferEvents:Number(row.bufferEvents)||0,affectedPercent:Math.round(ratio*100),
    severity: alert ? (ratio>=.65?'critical':'warning') : 'normal' };
}


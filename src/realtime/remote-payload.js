import { AppError } from '../shared/errors.js';
export function commandPayload(type, { note, telemetryIntervalSeconds } = {}) {
  if (type === 'show-message') {
    if (typeof note !== 'string' || note.trim().length < 3 || note.trim().length > 180) throw new AppError(422,'MESSAGE_INVALID','Mensagem deve ter entre 3 e 180 caracteres.');
    // Conteúdo é renderizado como texto puro no Roku, nunca como markup.
    return { text: note.trim().replace(/[\u0000-\u001f]/g, ' ') };
  }
  if (type === 'set-telemetry') {
    const seconds = Number(telemetryIntervalSeconds);
    if (!Number.isInteger(seconds) || seconds < 45 || seconds > 180) throw new AppError(422,'INVALID_INTERVAL','Intervalo deve ser entre 45 e 180 segundos.');
    return { telemetryIntervalSeconds: seconds };
  }
  return null;
}


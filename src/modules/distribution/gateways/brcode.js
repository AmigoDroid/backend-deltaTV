/** Pix "copia e cola" estático (BR Code / EMV) para a chave do próprio vendedor. Sem dependências e sem rede. */
export const KEY_TYPES = Object.freeze(['cpf_cnpj', 'email', 'phone', 'random']);

const tlv = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;
const ascii = (text, max) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^A-Za-z0-9 .\-]/g, '').trim().toUpperCase().slice(0, max);

/** CRC16/CCITT-FALSE (poly 0x1021, init 0xFFFF), exigido pelo campo 63 do BR Code. */
export function crc16(text) {
  let crc = 0xFFFF;
  for (const byte of Buffer.from(String(text), 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Normaliza e valida a chave Pix informada. Devolve null se for inválida para o tipo escolhido. */
export function normalizePixKey(type, raw) {
  const value = String(raw ?? '').trim();
  if (type === 'cpf_cnpj') { const d = value.replace(/\D/g, ''); return [11, 14].includes(d.length) ? d : null; }
  if (type === 'phone') {
    const d = value.replace(/\D/g, '');
    if (value.startsWith('+')) return d.length >= 12 && d.length <= 15 ? `+${d}` : null;
    return [10, 11].includes(d.length) ? `+55${d}` : (d.length >= 12 && d.length <= 13 && d.startsWith('55') ? `+${d}` : null);
  }
  if (type === 'email') return /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(value) && value.length <= 77 ? value.toLowerCase() : null;
  if (type === 'random') return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
  return null;
}

/** txid do BR Code: 1 a 25 caracteres alfanuméricos. */
export const txidOf = (orderId) => String(orderId).replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';

export function buildPixPayload({ key, name, city, amountCents, txid }) {
  if (!key || !name || !city) throw new Error('Chave, nome e cidade do recebedor são obrigatórios.');
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) throw new Error('Valor inválido para o Pix.');
  const merchant = tlv('00', 'br.gov.bcb.pix') + tlv('01', key);
  const body = tlv('00', '01') + tlv('01', '12') + tlv('26', merchant) + tlv('52', '0000') + tlv('53', '986')
    + tlv('54', (amountCents / 100).toFixed(2)) + tlv('58', 'BR')
    + tlv('59', ascii(name, 25) || 'RECEBEDOR') + tlv('60', ascii(city, 15) || 'BRASIL')
    + tlv('62', tlv('05', txid ? String(txid).replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***' : '***'));
  const withCrcId = `${body}6304`;
  return withCrcId + crc16(withCrcId);
}

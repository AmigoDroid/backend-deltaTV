import { isIP } from 'node:net';
import { z } from 'zod';
import { APPEARANCE_KEYS, contrastRatio } from './appearance.presets.js';

// The Roku image client must not be instructed to fetch local network endpoints.
export const secureImageUrl = z.string().trim().max(500).refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.$/, '').toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password &&
      !url.hash && !isIP(host) && !host.includes(':') && host !== 'localhost' &&
      !host.endsWith('.local') && !host.endsWith('.internal') &&
      !host.endsWith('.localhost');
  } catch { return false; }
}, 'Utilize uma imagem HTTPS pública (sem IP local, login ou fragmento).');
export const appearanceBody = z.object({
  template: z.enum(APPEARANCE_KEYS),
  brandName: z.string().trim().min(2).max(45),
  tagline: z.string().trim().max(110),
  heroTitle: z.string().trim().min(2).max(90),
  logoUrl: secureImageUrl,
  heroUrl: secureImageUrl,
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  panelColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
}).strict().superRefine((value, context) => {
  if (contrastRatio(value.textColor, value.backgroundColor) < 4.5 ||
      contrastRatio(value.textColor, value.panelColor) < 4.5)
    context.addIssue({ code: 'custom', path: ['textColor'],
      message: 'Contraste insuficiente: escolha texto legível sobre o fundo e o menu.' });
});

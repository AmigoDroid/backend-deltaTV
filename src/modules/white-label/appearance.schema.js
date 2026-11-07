import { isIP } from 'node:net';
import { z } from 'zod';
import { APPEARANCE_KEYS, contrastRatio } from './appearance.presets.js';
import { SCREEN_DEFAULTS, normalizeAppearanceScreens } from './appearance.screens.js';

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
const caption = (limit = 100) => z.string().trim().min(1).max(limit);
// Optional for older saved themes; new saves always include these screen settings.
const screenSchemas = {
  login: z.object({heading:caption(90),subtitle:caption(150),userLabel:caption(40),passwordLabel:caption(40),submitLabel:caption(36),footer:caption(110)}).strict(),
  home: z.object({heading:caption(90),subtitle:caption(150),liveLabel:caption(40),moviesLabel:caption(40),seriesLabel:caption(40),featuredLabel:caption(50),showBanner:z.boolean(),showFeatured:z.boolean()}).strict(),
  live: z.object({heading:caption(70),subtitle:caption(150),emptyLabel:caption(100)}).strict(),
  movies: z.object({heading:caption(70),subtitle:caption(150),searchLabel:caption(60),categoriesLabel:caption(50),emptyLabel:caption(100)}).strict(),
  series: z.object({heading:caption(70),subtitle:caption(150),searchLabel:caption(60),categoriesLabel:caption(50),emptyLabel:caption(100)}).strict(),
};
export const appearanceScreens = z.object(screenSchemas).strict();
const appearanceObject = z.object({
  template: z.enum(APPEARANCE_KEYS),
  screens: appearanceScreens.default(SCREEN_DEFAULTS),
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

// The route's validation middleware parses *before* the service. Normalize legacy v1
// payloads here, not just in the service, to preserve their customized Home text.
export const appearanceBody = z.preprocess(value => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? normalizeAppearanceScreens(value)
    : value
), appearanceObject);

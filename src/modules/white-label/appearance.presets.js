import { SCREEN_DEFAULTS } from './appearance.screens.js';
// White-label visual contract v2. Keep payloads small for Roku devices.
export const APPEARANCE_PRESETS = Object.freeze({
  classic: Object.freeze({
    name: 'Clássico', description: 'Banner, cartões e linha de destaques.',
    primaryColor: '#6B47E6', backgroundColor: '#090B14', panelColor: '#101321', textColor: '#FFFFFF',
  }),
  cinema: Object.freeze({
    name: 'Cinema', description: 'Banner imersivo e atalhos para as categorias.',
    primaryColor: '#E7A94B', backgroundColor: '#090B10', panelColor: '#17191F', textColor: '#FFFFFF',
  }),
  compact: Object.freeze({
    name: 'Compacto', description: 'Acesso rápido às categorias e aos destaques.',
    primaryColor: '#25B6A6', backgroundColor: '#081519', panelColor: '#10252B', textColor: '#F5FCFC',
  }),
  minimal: Object.freeze({
    name: 'Minimalista', description: 'Tipografia limpa e cards discretos, sem banner.',
    primaryColor: '#D4A45C', backgroundColor: '#11161B', panelColor: '#1B2229', textColor: '#F7F5EE',
  }),
  mosaic: Object.freeze({
    name: 'Mosaico', description: 'Navegação por blocos grandes, sem o banner clássico.',
    primaryColor: '#EC734F', backgroundColor: '#151316', panelColor: '#29232A', textColor: '#FFF6F0',
  }),
  library: Object.freeze({
    name: 'Biblioteca', description: 'Catálogo em evidência com navegação discreta.',
    primaryColor: '#93CBAA', backgroundColor: '#0D1615', panelColor: '#1A2B26', textColor: '#F3FBF6',
  }),
});
export const APPEARANCE_KEYS = Object.keys(APPEARANCE_PRESETS);
export function defaultAppearance(appName = 'Meu aplicativo', logoUrl = '') {
  return {
    template: 'classic', screens: structuredClone(SCREEN_DEFAULTS), brandName: String(appName).slice(0, 45), tagline: 'Seu entretenimento em um só lugar.',
    heroTitle: 'Bem-vindo', logoUrl: /^https:\/\//i.test(logoUrl || '') ? logoUrl : '', heroUrl: '',
    primaryColor: APPEARANCE_PRESETS.classic.primaryColor,
    backgroundColor: APPEARANCE_PRESETS.classic.backgroundColor,
    panelColor: APPEARANCE_PRESETS.classic.panelColor,
    textColor: APPEARANCE_PRESETS.classic.textColor,
  };
}
export function applyPreset(current, template) {
  const preset = APPEARANCE_PRESETS[template];
  if (!preset) throw new RangeError('Modelo visual inexistente.');
  return { ...current, template, primaryColor: preset.primaryColor,
    backgroundColor: preset.backgroundColor, panelColor: preset.panelColor, textColor: preset.textColor };
}

export function contrastRatio(hexA, hexB) {
  const luminance = hex => {
    const raw = [1, 3, 5].map(i => parseInt(hex.slice(i, i+2), 16) / 255);
    const linear = raw.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const a = luminance(hexA), b = luminance(hexB);
  return (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05);
}

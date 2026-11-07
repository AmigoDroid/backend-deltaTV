// Screen-local copy. Keep names stable: they are used by the web simulator and Roku SceneGraph.
export const SCREEN_DEFAULTS = Object.freeze({
  login: Object.freeze({heading:'Entre com sua conta IPTV',subtitle:'Use o usuário e a senha fornecidos pelo seu provedor.',userLabel:'Usuário',passwordLabel:'Senha',submitLabel:'Conectar',footer:'Acesso configurado pelo seu provedor'}),
  home: Object.freeze({heading:'Bem-vindo',subtitle:'Seu entretenimento em um só lugar.',liveLabel:'TV ao vivo',moviesLabel:'Filmes',seriesLabel:'Séries',featuredLabel:'Em destaque',showBanner:true,showFeatured:true}),
  live: Object.freeze({heading:'TV ao vivo',subtitle:'Escolha um canal para assistir.',emptyLabel:'Nenhum canal disponível'}),
  movies: Object.freeze({heading:'Filmes',subtitle:'Escolha algo para assistir.',searchLabel:'Buscar filmes',categoriesLabel:'Categorias',emptyLabel:'Nenhum filme encontrado'}),
  series: Object.freeze({heading:'Séries',subtitle:'Encontre sua próxima série.',searchLabel:'Buscar séries',categoriesLabel:'Categorias',emptyLabel:'Nenhuma série encontrada'}),
});

// Theme v1 used heroTitle/tagline only. Keep them when publishing an old draft.
export function normalizeAppearanceScreens(config = {}) {
  const legacyHome = config.screens?.home ? {} : {
    heading: config.heroTitle || SCREEN_DEFAULTS.home.heading,
    subtitle: config.tagline || SCREEN_DEFAULTS.home.subtitle,
  };
  return {...config, screens: Object.fromEntries(Object.entries(SCREEN_DEFAULTS).map(([name,defaults]) => [
    name, {...defaults, ...(name === 'home' ? legacyHome : {}), ...(config.screens?.[name] || {})},
  ]))};
}

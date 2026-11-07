'use strict';
const { randomUUID } = require('node:crypto');

module.exports = {
  async up(q, S) {
    await q.sequelize.transaction(async transaction => {
      await q.createTable('help_articles', {
        id: { type: S.UUID, primaryKey: true, allowNull: false },
        slug: { type: S.STRING(80), allowNull: false, unique: true },
        title: { type: S.STRING(160), allowNull: false },
        summary: { type: S.STRING(360), allowNull: false },
        category: { type: S.STRING(60), allowNull: false },
        audience: { type: S.STRING(16), allowNull: false, defaultValue: 'both' },
        body: { type: S.TEXT, allowNull: false },
        image_url: { type: S.STRING(800) },
        video_url: { type: S.STRING(800) },
        steps: { type: S.JSONB, allowNull: false, defaultValue: [] },
        status: { type: S.STRING(16), allowNull: false, defaultValue: 'draft' },
        is_onboarding: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
        sort_order: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
        created_at: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
      }, { transaction });
      await q.createTable('help_user_progress', {
        admin_user_id: { type: S.UUID, allowNull: false, primaryKey: true, references: { model: 'admin_users', key: 'id' }, onDelete: 'CASCADE' },
        article_id: { type: S.UUID, allowNull: false, primaryKey: true, references: { model: 'help_articles', key: 'id' }, onDelete: 'CASCADE' },
        step_index: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
        completed_at: { type: S.DATE },
        created_at: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
      }, { transaction });
      await q.createTable('help_user_states', {
        admin_user_id: { type: S.UUID, allowNull: false, primaryKey: true, references: { model: 'admin_users', key: 'id' }, onDelete: 'CASCADE' },
        welcome_seen_at: { type: S.DATE },
        created_at: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
      }, { transaction });
      await q.addIndex('help_articles', ['status', 'audience', 'sort_order'], { name: 'ix_help_articles_visible', transaction });
      await q.sequelize.query("ALTER TABLE help_articles ADD CONSTRAINT ck_help_article_audience CHECK (audience IN ('both','content','reseller'))", { transaction });
      await q.sequelize.query("ALTER TABLE help_articles ADD CONSTRAINT ck_help_article_status CHECK (status IN ('draft','published','disabled'))", { transaction });
      await q.sequelize.query('ALTER TABLE help_user_progress ADD CONSTRAINT ck_help_progress_step CHECK (step_index BETWEEN 0 AND 16)', { transaction });
      const articles = [
        {
          slug: 'primeiros-passos', title: 'Primeiros passos no painel', category: 'Comece aqui', audience: 'both', isOnboarding: true, sortOrder: -100,
          summary: 'Conheça a página inicial, o menu, a ajuda e sua conta.',
          body: 'Este guia mostra onde encontrar as funções principais do seu painel.\nVocê pode interromper o tutorial e retomá-lo em Central de Ajuda.\nAs opções exibidas dependem do seu tipo de parceria e dos recursos contratados.',
          steps: [
            { title: 'Bem-vindo ao painel', body: 'Na página inicial você acompanha as informações principais da sua operação.', target: 'home', screen: 'home' },
            { title: 'Central de Ajuda', body: 'Abra a Central de Ajuda para pesquisar guias e recomeçar tutoriais a qualquer momento.', target: 'help', screen: 'help' },
            { title: 'Segurança da conta', body: 'Em Minha conta, edite seu perfil e gerencie senha e sessões.', target: 'profile', screen: 'profile' },
          ],
        },
        {
          slug: 'configurar-servidores', title: 'Cadastrar servidores IPTV', category: 'Conteúdo', audience: 'content', isOnboarding: false, sortOrder: 10,
          summary: 'Cadastre URLs do seu provedor e acompanhe o monitoramento.',
          body: 'Em Servidores, adicione os endereços do seu próprio provedor. Use HTTPS quando disponível e confira se a URL está correta.\nDepois, acesse Monitoramento para verificar latência e disponibilidade. Uma resposta HTTP saudável não garante reprodução de mídia.',
          steps: [
            { title: 'Abrir Servidores', body: 'No menu Servidores, gerencie as URLs associadas à parceria.', target: 'servers', screen: 'servers' },
            { title: 'Adicionar uma URL', body: 'Use Adicionar servidor para registrar a URL de um provedor seu. Este guia não executa alterações sozinho.', target: 'add-server', screen: 'servers' },
            { title: 'Configurar códigos', body: 'Associe os códigos aos servidores cadastrados. Valide com um dispositivo de teste.', target: 'codes', screen: 'codes' },
          ],
        },
        {
          slug: 'criar-codigos', title: 'Organizar códigos de ativação', category: 'Ativações', audience: 'both', isOnboarding: false, sortOrder: 20,
          summary: 'Entenda onde gerenciar os códigos utilizados pelos aplicativos.',
          body: 'Os códigos associam o dispositivo ao contrato e, conforme as regras da sua parceria, aos servidores de conteúdo.\nConfira os limites e permissões antes de entregar um código ao seu cliente.',
          steps: [{ title: 'Códigos', body: 'Acesse o menu Códigos. Revise o código e seu vínculo antes de ativar um cliente.', target: 'codes', screen: 'codes' }],
        },
        {
          slug: 'gestao-de-ativacoes', title: 'Consultar dispositivos e ativações', category: 'Ativações', audience: 'reseller', isOnboarding: false, sortOrder: 30,
          summary: 'Localize uma TV, confira o vínculo e acompanhe licenças.',
          body: 'Use o MAC do dispositivo para pesquisar a TV. Evite criar mais de um registro para o mesmo equipamento.\nEm Licenças, verifique o prazo e a situação das ativações de sua responsabilidade.',
          steps: [
            { title: 'Pesquisar dispositivo', body: 'Acesse Dispositivos e consulte a TV pelo MAC.', target: 'devices', screen: 'devices' },
            { title: 'Buscar pelo MAC', body: 'No campo de pesquisa, informe o MAC do dispositivo desejado.', target: 'search-device', screen: 'devices' },
            { title: 'Conferir licenças', body: 'Verifique vencimento, renovação e situação das licenças.', target: 'licenses', screen: 'licenses' },
          ],
        },
        {
          slug: 'faturas-e-pagamentos', title: 'Faturas e pagamentos', category: 'Financeiro', audience: 'both', isOnboarding: false, sortOrder: 40,
          summary: 'Saiba onde conferir mensalidades e pagamentos.',
          body: 'Na área Financeiro ou Faturas e pagamentos, acompanhe seus vencimentos, valores e estados de cobrança.\nAntes de pagar uma cobrança, verifique valor, destinatário e competência.',
          steps: [{ title: 'Abrir financeiro', body: 'Consulte faturas e situação dos pagamentos vinculados à sua conta.', target: 'billing', screen: 'billing' }],
        },
        {
          slug: 'estudio-visual', title: 'Personalizar seu aplicativo', category: 'Aplicativos', audience: 'content', isOnboarding: false, sortOrder: 50,
          summary: 'Configure temas e veja as mudanças no simulador Roku.',
          body: 'Se seu aplicativo tiver o Estúdio Visual habilitado, selecione um modelo, escolha a tela e personalize textos, cores e imagens.\nSalve como rascunho e use o simulador antes de publicar. Depois, gere um pacote novo quando a alteração exigir atualização do canal na loja.',
          steps: [{ title: 'Encontrar o Estúdio Visual', body: 'A opção aparece somente quando o Superadmin libera o recurso para um aplicativo.', target: 'studio', screen: 'studio' }],
        },
        {
          slug: 'seguranca-do-perfil', title: 'Segurança da sua conta', category: 'Minha conta', audience: 'both', isOnboarding: false, sortOrder: 60,
          summary: 'Troque senha, confira sessões e reconheça acessos.',
          body: 'Na página Minha conta, revise seu e-mail, telefone e sessões conectadas. Encerre sessões desconhecidas.\nNunca compartilhe senhas ou links de redefinição. Se perder acesso, use Esqueci minha senha na página de login.',
          steps: [{ title: 'Minha conta', body: 'Acesse seu perfil para ajustar dados pessoais e segurança.', target: 'profile', screen: 'profile' }],
        },
      ];
      const now = new Date();
      await q.bulkInsert('help_articles', articles.map(a => ({
        id: randomUUID(), slug: a.slug, title: a.title, category: a.category, audience: a.audience,
        summary: a.summary, body: a.body, steps: JSON.stringify(a.steps), status: 'published',
        is_onboarding: a.isOnboarding, sort_order: a.sortOrder,
        image_url: null, video_url: null, created_at: now, updated_at: now,
      })), { transaction });
    });
  },
  async down(q) {
    await q.sequelize.transaction(async transaction => {
      await q.dropTable('help_user_progress', { transaction });
      await q.dropTable('help_user_states', { transaction });
      await q.dropTable('help_articles', { transaction });
    });
  },
};

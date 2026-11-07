'use strict';
const { randomUUID } = require('node:crypto');

// New guides are inserted without replacing content written by the superadmin.
// Existing introductory guides are expanded only when their body still equals the original seed.
const step = (title, body, screen, target, tip, mode = 'panel') => ({
  title, body, ...(screen ? { screen } : {}), ...(target ? { target } : {}), ...(tip ? { tip } : {}), mode,
});
const tv = (title, body, tip) => step(title, body, null, null, tip, 'external');
const guides = [
  {
    slug: 'roku-delta-qr', title: 'Adicionar sua lista no DeltaTV Roku usando QR Code', category: 'Configurar TV', audience: 'both', sortOrder: -35,
    summary: 'Da primeira abertura do aplicativo à confirmação da lista, usando a câmera do celular.',
    body: 'Este roteiro serve para o aplicativo DeltaTV tradicional que mostra QR Code e identificador do dispositivo. Não use este roteiro se seu aplicativo tem uma marca própria e pede somente usuário e senha.\nVocê precisa ter o DeltaTV instalado na Roku, acesso à internet, um celular e credenciais válidas do seu serviço de IPTV. O DeltaTV é um reprodutor: não fornece conteúdo ou assinatura IPTV.\nNunca envie senhas ou links privados em grupos públicos. Use somente listas para as quais você tem autorização.',
    steps: [
      tv('Abra o canal DeltaTV na Roku', 'Ligue a TV, entre na tela inicial da Roku e abra o DeltaTV instalado. Na primeira execução, aguarde a tela Conectar dispositivo.', 'Aparecem as opções de conexão ou o estado de configuração da TV.'),
      tv('Confira o QR Code e o identificador', 'Na tela Conectar dispositivo, localize o QR Code e o MAC virtual ou código do dispositivo. Esses dados identificam a instalação na plataforma.', 'O QR fica na TV e não precisa ser copiado manualmente quando o celular consegue lê-lo.'),
      tv('Escaneie o código com o celular', 'Abra a câmera do celular, aponte para o QR Code e toque no endereço mostrado. Confirme se o endereço pertence à plataforma de ativação usada pelo seu provedor.', 'A página deve abrir no navegador e identificar a TV; não digite credenciais em páginas desconhecidas.'),
      tv('Confira os dados da TV na página', 'Na página indicada pelo QR, confira se o identificador do dispositivo corresponde ao exibido na Roku. Se não aparecer corretamente, volte à TV e escaneie novamente.', 'Não ative outro MAC por engano.'),
      tv('Escolha o modo de configuração disponível', 'Se a parceria usar código, informe o código do parceiro e o usuário e a senha da lista Xtream. Se o contrato usar licença e playlist, siga os campos de licença, nome e URL de lista exibidos na página.', 'Os campos podem variar conforme o tipo de contrato; use somente os dados fornecidos pelo responsável pelo conteúdo.'),
      tv('Envie e aguarde a validação', 'Confirme o cadastro no celular uma única vez. Volte à TV e aguarde a verificação automática. Não precisa enviar o mesmo formulário repetidamente.', 'O estado deve evoluir de aguardando configuração para acesso configurado.'),
      tv('Confirme a abertura do catálogo', 'Se a TV não atualizar sozinha, use a opção de conectar/confirmar indicada na tela ou reabra o canal. Aguarde as categorias carregarem.', 'Devem aparecer TV ao vivo, Filmes ou Séries conforme o conteúdo autorizado no servidor.'),
      tv('Faça um teste de reprodução', 'Abra um canal ou filme autorizado, teste som e imagem e volte ao catálogo. Se o conteúdo não abrir, consulte o guia Diagnosticar problemas de conexão.', 'Concluir o login não garante que o servidor de mídia esteja respondendo.'),
    ],
  },
  {
    slug: 'roku-delta-controle', title: 'Adicionar uma lista diretamente pelo controle Roku', category: 'Configurar TV', audience: 'both', sortOrder: -34,
    summary: 'Aprenda a preencher código, usuário, senha ou playlist sem utilizar o QR Code.',
    body: 'Este roteiro serve para a tela Conectar dispositivo da versão DeltaTV tradicional. As opções variam entre acesso por parceria e licença/playlist.\nO controle Roku abre o teclado da TV para cada campo. Se o seu app tiver a marca do contratante e pedir somente usuário/senha IPTV, use o guia de aplicativo white-label.',
    steps: [
      tv('Abra Conectar dispositivo', 'Inicie o DeltaTV na Roku. Se já houver uma lista, abra Configurações → Conteúdo → Gerenciador de listas → Adicionar lista para abrir a tela de conexão.', 'A tela tem campos de acesso e a ação Conectar.'),
      tv('Selecione o tipo de acesso', 'Verifique se a tela está no modo de código de parceria ou de licença/lista. Use o modo que o responsável pelo conteúdo informou.', 'Parceria usa código + usuário/senha IPTV; licença/lista usa código de licença, nome e URL da playlist quando exigidos.'),
      tv('Preencha o primeiro campo', 'Selecione com as setas o código de parceria ou da licença, pressione OK e digite o código no teclado Roku. Confirme o teclado.', 'Evite espaços extras e confira cada caractere.'),
      tv('Preencha usuário e senha OU dados da playlist', 'No modo parceria, digite usuário e senha Xtream fornecidos pelo provedor. No modo licença/lista, informe o nome e a URL HTTP(S) completa da playlist, se essa opção aparecer.', 'Não confunda URL base do servidor com URL completa de playlist; use exatamente o formato solicitado.'),
      tv('Selecione Conectar', 'Com os campos preenchidos, use as setas para selecionar Conectar e pressione OK uma vez. Aguarde a validação.', 'Se houver erro, leia a mensagem da TV antes de tentar novamente.'),
      tv('Verifique o resultado', 'Após a confirmação, entre nas categorias do catálogo e teste um conteúdo autorizado. Se a TV indicar sessão necessária ou licença pendente, procure o administrador.', 'Só conclua esta etapa se a conexão e o catálogo estiverem funcionando.'),
    ],
  },
  {
    slug: 'roku-delta-varias-listas', title: 'Adicionar outra lista e alternar entre listas na Roku', category: 'Configurar TV', audience: 'both', sortOrder: -33,
    summary: 'Abra o gerenciador de listas, inclua uma nova conta e alterne sem misturar os catálogos.',
    body: 'O DeltaTV tradicional permite gerenciar mais de uma lista na TV. Cada lista pode ter catálogo e configuração próprios.\nAo adicionar uma lista, a anterior não deve ser apagada automaticamente. Se a opção não aparecer, confirme a versão instalada do aplicativo.',
    steps: [
      tv('Abra Configurações', 'Dentro do DeltaTV, navegue pelo controle remoto até Configurações.', 'A seção Conteúdo deve aparecer nas opções.'),
      tv('Entre em Conteúdo', 'Selecione Conteúdo. A opção abre o Gerenciador de listas.', 'Não confunda com as categorias de filmes ou séries.'),
      tv('Selecione Adicionar lista', 'No Gerenciador de listas, escolha Adicionar lista. O aplicativo abre a tela de conexão, onde você pode usar QR Code ou os campos da própria TV.', 'A lista atual fica preservada se você cancelar a adição.'),
      tv('Configure a nova lista', 'Informe os dados do novo provedor conforme o modo de ativação exibido. Aguarde a confirmação da sessão e o carregamento do catálogo.', 'Cada provedor deve usar seus próprios dados de acesso.'),
      tv('Alterne entre listas', 'Retorne a Configurações → Conteúdo → Gerenciador de listas, selecione a lista desejada e escolha Usar esta lista.', 'Verifique se as categorias mudaram para a lista selecionada.'),
      tv('Atualize ou exclua com cuidado', 'Use as ações de atualizar ou excluir conforme disponíveis. Antes de excluir, confirme o nome da lista; isso remove sua configuração local e poderá exigir novo login.', 'Não exclua listas de outros usuários sem autorização.'),
    ],
  },
  {
    slug: 'roku-white-label-login', title: 'Entrar em um aplicativo Roku de marca própria', category: 'Configurar TV', audience: 'both', sortOrder: -32,
    summary: 'Apps white-label pedem usuário e senha IPTV; as URLs são configuradas pelo contratante no painel.',
    body: 'Este roteiro é para aplicativos Roku white-label gerados pela plataforma, com nome e logotipo próprios. Ele não usa o código de parceria do DeltaTV tradicional.\nO dono do aplicativo cadastra os servidores no painel Meus aplicativos. O assinante apenas informa usuário e senha da lista IPTV fornecidos pelo provedor autorizado.\nSe a mensalidade do aplicativo ou o limite de ativações estiver bloqueado, o responsável pelo aplicativo deve resolver o contrato no painel.',
    steps: [
      tv('Abra o aplicativo de marca própria na Roku', 'Selecione o canal do contratante já instalado na TV. Aguarde a tela de acesso IPTV.', 'O nome do aplicativo deve ser a marca do contratante e não DeltaTV, quando o ZIP próprio foi publicado.'),
      tv('Confirme os dados recebidos', 'Tenha em mãos seu usuário e senha Xtream. Não é necessário digitar URL do servidor na TV: o dono do aplicativo já configurou essa informação no painel.', 'Se pedirem um código de parceria, você provavelmente está usando o DeltaTV tradicional e deve seguir outro tutorial.'),
      tv('Digite o usuário IPTV', 'Selecione Usuário IPTV, pressione OK, digite o usuário no teclado Roku e confirme.', 'Verifique maiúsculas, números e ausência de espaços.'),
      tv('Digite a senha IPTV', 'Selecione Senha IPTV e digite a senha fornecida pelo serviço autorizado. O campo de senha deve ocultar os caracteres.', 'Nunca compartilhe a senha com o suporte em grupo público.'),
      tv('Conecte o aplicativo', 'Selecione a opção de conexão indicada no tema e pressione OK. O aplicativo valida as credenciais e a autorização desta instalação.', 'Caso exceda o limite contratual de TVs, peça ao dono do aplicativo para liberar uma instalação.'),
      tv('Teste o catálogo e a reprodução', 'Após o login, navegue por TV ao vivo, Filmes e Séries conforme o catálogo disponível. Abra um conteúdo autorizado para testar.', 'Se as credenciais estiverem corretas e nada carregar, o servidor IPTV configurado no painel pode estar indisponível.'),
    ],
  },
  {
    slug: 'roku-problemas-de-conexao', title: 'Resolver erros ao subir a lista na TV Roku', category: 'Configurar TV', audience: 'both', sortOrder: -31,
    summary: 'Diagnostique QR que não abre, credenciais inválidas, licença pendente e catálogo sem conteúdo.',
    body: 'Use este roteiro quando a tela de conexão não avança, a lista não aparece ou o catálogo abre sem reproduzir. Antes de qualquer alteração, identifique se usa DeltaTV tradicional ou app white-label.\nNão compartilhe capturas de tela com senha, tokens, endereços privados ou QR de pareamento ativos.',
    steps: [
      tv('Confira a conexão com a internet', 'Na própria Roku, verifique em Configurações de rede se a TV está conectada. Teste outro aplicativo que já funcione.', 'Sem rede, o catálogo e a validação podem não abrir.'),
      tv('Se o QR falhar, confira o endereço', 'Tente escanear novamente o QR e abra apenas o endereço oficial exibido. Se continuar sem abrir, teste outro navegador e solicite ao responsável o link de cadastro.', 'O endereço do QR pode ser diferente conforme a versão do aplicativo.'),
      tv('Se der credenciais inválidas', 'Revise exatamente o usuário e a senha do provedor IPTV. No DeltaTV tradicional confira também o código da parceria ou licença. Em white-label, confira apenas usuário e senha.', 'Não repita a tentativa muitas vezes se o fornecedor tiver proteção contra bloqueio.'),
      tv('Se mostrar licença pendente ou dispositivo desativado', 'O login do conteúdo não substitui a autorização/licença da instalação. Solicite ao parceiro ou revendedor que confira a situação do dispositivo no painel.', 'Não é necessário reinstalar o app para tentar corrigir todas as situações de licença.'),
      tv('Se o catálogo carregar mas o vídeo não abrir', 'Teste um segundo conteúdo, verifique se o servidor do provedor está acessível e solicite ao responsável a conferência da URL e do formato de streaming.', 'Uma API Xtream acessível não garante que todos os streams estejam reproduzíveis.'),
      tv('Reabra o aplicativo e teste novamente', 'Depois de corrigir a situação, feche e reabra o canal, aguarde a atualização do catálogo e refaça o teste de reprodução.', 'Se persistir, informe ao suporte apenas a mensagem de erro, versão do app e código público do dispositivo (sem senha).'),
    ],
  },
];

const upgrades = [
  {
    slug: 'primeiros-passos', old: 'Este guia mostra onde encontrar as funções principais do seu painel.\nVocê pode interromper o tutorial e retomá-lo em Central de Ajuda.\nAs opções exibidas dependem do seu tipo de parceria e dos recursos contratados.',
    body: 'O painel reúne o gerenciamento da parceria, dos dispositivos e do seu aplicativo. Os menus dependem do perfil e dos serviços contratados.\nSiga as opções destacadas para se familiarizar. Você pode clicar nos controles reais enquanto o tour está aberto, sem que ele execute ações em seu nome. Marque uma etapa como feita somente quando entender o procedimento.\nPara ensinar seu cliente a subir a lista na televisão, abra a categoria Configurar TV. Há tutoriais diferentes para DeltaTV tradicional e aplicativo white-label.',
    steps: [
      step('Conheça a página inicial', 'A página Início resume os dados da operação. Encontre os indicadores e entenda qual área corresponde a cada serviço.', 'home', 'home', 'O menu Início fica destacado; você pode clicar nele.'),
      step('Encontre os códigos', 'A área Códigos gerencia os identificadores usados para associar serviços e clientes, conforme seu tipo de parceria.', 'codes', 'codes', 'Não compartilhe códigos de ativação publicamente.'),
      step('Localize os dispositivos', 'Em Dispositivos consulte a situação de uma TV antes de cadastrar ou renovar. Algumas funções dependem do plano.', 'devices', 'devices', 'Verifique o identificador do dispositivo correto.'),
      step('Confira pagamentos e limites', 'Abra Financeiro para localizar mensalidades, saldos ou operações disponíveis para sua conta.', 'billing', 'billing', 'Prazos e funcionalidades diferem conforme o contrato.'),
      step('Visite a Central de Ajuda', 'A Central reúne guias com checklist e procedimentos que você pode seguir quando precisar.', 'help', 'help', 'Escolha a categoria Configurar TV para aprender a adicionar listas no Roku.'),
      step('Proteja Minha conta', 'Em Minha conta você poderá revisar dados, senha, sessões e informações de acesso.', 'profile', 'profile', 'Desconecte sessões desconhecidas e mantenha seu e-mail atualizado.'),
    ],
  },
  {
    slug: 'configurar-servidores', old: 'Em Servidores, adicione os endereços do seu próprio provedor. Use HTTPS quando disponível e confira se a URL está correta.\nDepois, acesse Monitoramento para verificar latência e disponibilidade. Uma resposta HTTP saudável não garante reprodução de mídia.',
    body: 'O parceiro cadastra os endereços dos servidores IPTV que administra ou está autorizado a utilizar. A URL deve ser a base Xtream correta, com HTTPS quando disponível.\nUma mesma parceria pode ter alternativas de servidor. O sistema testa disponibilidade e organiza a prioridade, mas isso não garante que vídeos específicos funcionem. O app white-label consulta os servidores do contratante, e o assinante digita apenas usuário/senha.\nNunca cadastre URLs de terceiros sem autorização nem compartilhe senhas no tutorial.',
    steps: [
      step('Abra o menu Servidores', 'Clique no menu Servidores. A lista mostra as URLs cadastradas, o estado e a prioridade.', 'servers', 'servers', 'Esta tela existe no painel de Parceiro de Conteúdo.'),
      step('Localize Adicionar servidor', 'Aperte Adicionar servidor. O formulário permite informar nome, URL base e prioridade.', 'servers', 'add-server', 'Abra a janela e confira se os campos do servidor apareceram.'),
      step('Preencha a URL corretamente', 'Use a URL base do fornecedor que você controla. Não inclua usuário e senha em parâmetros públicos sem necessidade.', 'servers', 'servers', 'Confira esquema HTTP(S), domínio e eventual porta.'),
      step('Salve e verifique a disponibilidade', 'Depois de salvar, confira a resposta de monitoramento e teste o login de um usuário autorizado.', 'servers', 'servers', 'Uma resposta saudável não comprova reprodução de todos os canais.'),
      step('Associe o servidor ao código', 'Acesse Códigos e verifique como o acesso do cliente está ligado à parceria e ao servidor.', 'codes', 'codes', 'Não troque códigos ativos sem avaliar cobrança e impacto em clientes.'),
      step('Teste a lista numa TV', 'Abra na Central de Ajuda o roteiro Configurar TV adequado e faça um teste real de catálogo/reprodução.', 'help', 'help', 'Escolha entre DeltaTV tradicional e o app com marca própria.'),
    ],
  },
  {
    slug: 'criar-codigos', old: 'Os códigos associam o dispositivo ao contrato e, conforme as regras da sua parceria, aos servidores de conteúdo.\nConfira os limites e permissões antes de entregar um código ao seu cliente.',
    body: 'Os códigos são identificadores de acesso à parceria ou licença, conforme as regras do produto. Não substituem o usuário e a senha Xtream.\nCrie um código quando seu contrato permitir, confira o vínculo ao servidor e informe o cliente sobre o tipo de configuração na televisão. Na versão white-label com usuário/senha simples, o assinante pode não precisar de código.',
    steps: [
      step('Abra Códigos', 'Localize o menu Códigos no painel.', 'codes', 'codes', 'A lista pode mudar conforme o tipo de parceria.'),
      step('Encontre a ação Novo código', 'Clique em Novo código quando estiver disponível.', 'codes', 'new-code', 'Confira limites e servidor antes de confirmar a criação.'),
      step('Revise os dados de acesso', 'Confira código, descrição, vínculo com servidor e regras comerciais. Não confunda código com login IPTV.', 'codes', 'codes', 'Não envie usuário/senha em mensagens públicas.'),
      step('Teste o código na TV', 'Oriente o cliente pelo guia de QR ou pelo controle Roku. O app white-label com marca própria usa outro fluxo.', 'help', 'help', 'A TV deve reconhecer o contrato e carregar o catálogo.'),
    ],
  },
  {
    slug: 'gestao-de-ativacoes', old: 'Use o MAC do dispositivo para pesquisar a TV. Evite criar mais de um registro para o mesmo equipamento.\nEm Licenças, verifique o prazo e a situação das ativações de sua responsabilidade.',
    body: 'Na Revenda, a TV é identificada por código ou MAC virtual. Localizar a TV certa evita cobrar ou alterar o dispositivo errado.\nAntes de renovar, transferir ou bloquear, confirme os dados da licença e seu prazo. Essas ações só devem ser feitas com autorização do responsável.',
    steps: [
      step('Abra Dispositivos', 'Clique em Dispositivos para ver as TVs vinculadas à revenda.', 'devices', 'devices', 'Confira o status antes de alterar qualquer coisa.'),
      step('Encontre a busca por MAC', 'Use o campo Pesquisar por MAC para localizar o equipamento.', 'devices', 'search-device', 'Digite o identificador exato mostrado na Roku.'),
      step('Confirme a TV correta', 'Verifique os últimos dados conhecidos, a situação de acesso e o vínculo à conta.', 'devices', 'devices', 'Não altere dispositivos de outras pessoas.'),
      step('Confira a licença', 'Em Licenças examine o vencimento e as ações disponíveis.', 'licenses', 'licenses', 'Renovação e transferências obedecem às regras comerciais.'),
      step('Ensine o cliente a conectar', 'Abra o guia da TV no menu Ajuda e oriente o cliente sobre QR ou dados pelo controle.', 'help', 'help', 'Antes de encerrar, confirme catálogo e reprodução.'),
    ],
  },
  {
    slug: 'faturas-e-pagamentos', old: 'Na área Financeiro ou Faturas e pagamentos, acompanhe seus vencimentos, valores e estados de cobrança.\nAntes de pagar uma cobrança, verifique valor, destinatário e competência.',
    body: 'A área financeira mostra informações de cobrança conforme o contrato. Cada mensalidade pode ter uma competência, um vencimento e um estado.\nAntes de pagar via Pix, confira valor, identificação da cobrança e favorecido. Não envie dinheiro com base apenas em prints e não confunda créditos consumidos com pagamento confirmado.',
    steps: [
      step('Abra Financeiro', 'Use o menu Financeiro para consultar valores, débitos e pagamentos disponíveis na sua conta.', 'billing', 'billing', 'Verifique o período e o destinatário da cobrança.'),
      step('Confira a situação da fatura', 'Identifique se está pendente, paga, vencida ou em análise. Evite gerar ou pagar cobranças repetidas.', 'billing', 'billing', 'Não considere a fatura quitada só porque um QR Pix foi criado.'),
      step('Revise antes de pagar', 'Confira valor, competência e favorecido antes de confirmar qualquer transação externa.', 'billing', 'billing', 'A confirmação financeira depende da conciliação do pagamento.'),
    ],
  },
  {
    slug: 'estudio-visual', old: 'Se seu aplicativo tiver o Estúdio Visual habilitado, selecione um modelo, escolha a tela e personalize textos, cores e imagens.\nSalve como rascunho e use o simulador antes de publicar. Depois, gere um pacote novo quando a alteração exigir atualização do canal na loja.',
    body: 'Se o Superadmin ativou o Estúdio Visual para seu aplicativo, você pode escolher um modelo pronto ou personalizar textos e cores por tela, mantendo o simulador ao lado.\nSalve um rascunho, teste Login, Home, Filmes e Séries, e publique somente quando estiver satisfeito. Modificações de nome/ícone/splash de um canal já distribuído podem exigir um novo ZIP, assinatura e publicação Roku.',
    steps: [
      step('Abra Meus aplicativos', 'Localize o aplicativo específico de sua parceria antes de mudar sua identidade visual.', 'apps', 'apps', 'Não altere o aplicativo de outro contratante.'),
      step('Entre no Estúdio Visual', 'Abra o Estúdio Visual se estiver habilitado pelo Superadmin.', 'studio', 'studio', 'Se o menu não aparecer, peça habilitação ao administrador.'),
      step('Escolha um modelo', 'Selecione o estilo Clássico, Cinema, Compacto, Minimalista, Mosaico ou Biblioteca.', 'studio', 'studio', 'O modelo escolhido deve ser compatível com a build Roku publicada.'),
      step('Edite uma tela por vez', 'Selecione Login, Home, Filmes ou Séries e altere os textos e cores nos campos do editor compacto.', 'studio', 'studio', 'O simulador deverá refletir as alterações imediatamente.'),
      step('Teste e salve o rascunho', 'Use Rodar, navegue pelas telas e teste a legibilidade. Depois salve como rascunho.', 'studio', 'studio', 'A prévia no navegador não substitui teste em uma Roku real.'),
      step('Publique e gere um novo pacote se necessário', 'Publique o tema aprovado. Se precisar de novo nome, ícone, splash ou alterações de código, gere ZIP Premium e providencie assinatura e certificação.', 'studio', 'studio', 'Publicar um tema não atualiza automaticamente um pacote Roku já assinado quando a alteração exige nova build.'),
    ],
  },
  {
    slug: 'seguranca-do-perfil', old: 'Na página Minha conta, revise seu e-mail, telefone e sessões conectadas. Encerre sessões desconhecidas.\nNunca compartilhe senhas ou links de redefinição. Se perder acesso, use Esqueci minha senha na página de login.',
    body: 'Em Minha conta você gerencia sua identidade e segurança. O painel permite atualizar senha, telefone e outros dados conforme suas permissões.\nPara trocar senha, utilize sua senha atual; para recuperá-la sem login, use Esqueci minha senha na entrada do portal. Revise sessões e desconecte dispositivos que não reconhece.',
    steps: [
      step('Abra Minha conta', 'Clique no menu Minha conta para acessar dados pessoais e segurança.', 'profile', 'profile', 'Faça alterações somente na sua conta.'),
      step('Confira dados cadastrais', 'Atualize telefone, e-mail e foto quando necessário. Alterações sensíveis podem pedir senha atual.', 'profile', 'profile', 'Use um e-mail que você controla.'),
      step('Revise sessões', 'Na área de sessões, encerre acessos desconhecidos e mantenha somente seus dispositivos.', 'profile', 'profile', 'Se suspeitar de invasão, troque a senha e encerre outras sessões.'),
      step('Aprenda a recuperar senha', 'Se perder acesso no futuro, clique em Esqueci minha senha na tela de login do seu portal. O link de recuperação expira.', 'profile', 'profile', 'Nunca encaminhe links de redefinição.'),
    ],
  },
];

const now = () => new Date();
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async transaction => {
      for (const guide of upgrades) {
        // The initial seed inserted identical created_at/updated_at values. Any subsequent admin edit
        // changes updated_at; do not overwrite a guide that has been customized in any field.
        await q.sequelize.query(`UPDATE help_articles
          SET body = :body, summary = :summary, steps = CAST(:steps AS jsonb), updated_at = CURRENT_TIMESTAMP
          WHERE slug = :slug AND body = :oldBody AND updated_at = created_at`, {
          replacements: { slug: guide.slug, oldBody: guide.old, body: guide.body,
            summary: `Guia prático com ${guide.steps.length} etapas: ${guide.steps[0].title.toLowerCase()} e muito mais.`,
            steps: JSON.stringify(guide.steps) }, transaction,
        });
      }
      const [rows] = await q.sequelize.query('SELECT slug FROM help_articles', { transaction });
      const existing = new Set((rows || []).map(r => r.slug));
      const insertedAt = now();
      const insert = guides.filter(g => !existing.has(g.slug)).map(g => ({
        id: randomUUID(), slug: g.slug, title: g.title, summary: g.summary, category: g.category,
        audience: g.audience, body: g.body, steps: JSON.stringify(g.steps), status: 'published',
        is_onboarding: false, sort_order: g.sortOrder, image_url: null, video_url: null,
        created_at: insertedAt, updated_at: insertedAt,
      }));
      if (insert.length) await q.bulkInsert('help_articles', insert, { transaction });
    });
  },
  async down(q) {
    await q.sequelize.transaction(async transaction => {
      for (const guide of guides) {
        // A customized guide must survive a rollback. Avoid deleting later admin edits.
        await q.sequelize.query('DELETE FROM help_articles WHERE slug = :slug AND body = :body AND updated_at = created_at', {
          replacements: { slug: guide.slug, body: guide.body }, transaction,
        });
      }
      // Do not roll back the text of older articles: an admin may have edited them since this migration.
    });
  },
};
module.exports._test = { guides, upgrades };

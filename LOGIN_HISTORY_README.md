# Delta TV — Histórico de login

## Instalação
1. Faça backup do PostgreSQL.
2. Publique o backend atualizado e aplique `npm run db:migrate` **antes** de iniciar o novo backend.
3. Publique os builds novos do admin e do portal da revenda.

## Acesso
- Superadmin: menu `Sistema > Histórico de login` (todas as contas).
- Revendedor: menu `Conta > Histórico de login` (somente seu usuário).
- API: `GET /api/v1/auth/history?page=1&limit=25&outcome=success|failure` (Bearer JWT).

## Campos
Data/hora (UTC no banco; horário local no painel), IP obtido por Express, User-Agent,
sistema e navegador inferidos do User-Agent, categoria aproximada do dispositivo,
ISP e região/cidade/país aproximados conforme a base externa.

## Segurança e privacidade
- Não armazena senha nem token na tabela de histórico.
- Tentativas de e-mail inexistente não persistem o e-mail informado.
- Os provedores de rede são obtidos por consulta HTTPS a ipwho.is somente para IP público válido;
  o serviço externo recebe o IP, de acordo com sua política de privacidade.
- Defina `LOGIN_HISTORY_ISP_LOOKUP=false` para desabilitar essa consulta.
- A indisponibilidade do serviço de IP não impede o login; o campo pode ficar vazio.
- `trust proxy` deve ser configurado restrito ao proxy conhecido; não confie em X-Forwarded-For
  vindo diretamente da internet (evita falsificação do IP de origem).
- Em VPN, proxy, NAT ou conexão móvel, o IP pode apontar para outro provedor/região.
- O navegador não revela modelo/identidade física confiável; os campos são estimativas.
- Planeje política de retenção/acesso conforme LGPD antes de produção.

## Validação
- Código backend passou em `node --check`.
- Build frontend e testes integrados não executados neste ambiente por ausência de dependências npm.

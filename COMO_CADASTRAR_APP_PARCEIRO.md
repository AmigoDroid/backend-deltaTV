# Como cadastrar um app Roku próprio para um parceiro

Painel Admin → **Apps da plataforma** (o passo a passo também aparece na própria tela).

1. **Cadastrar o app** — Nome + **Identificador**. O identificador precisa ser **igual** ao `DeltaAppId()` em `source/Config.brs` do app Roku (ex.: `dreamplayer`). Não use `roku` nem `delta-tv-roku` (reservados). Não muda depois.
2. **Entregar ao parceiro** (escolha um):
   - **Atribuir a parceiro**: busque o parceiro, escolha o código dele na lista, confirme. Direto.
   - **Gerar código de vinculação**: envie ao parceiro o identificador + código (aparece uma vez, vale 24 h). Ele cola em **Meus Apps → Adicionar App**.
   - Pré-requisito: o plano do parceiro precisa ter **vaga de app** (`max_apps`).
3. **Pronto**: as TVs que instalarem o app informam usuário/senha do provedor; entram pelo código do parceiro. O app fala com o servidor por WebSocket.

Para criar o app novo: copie o projeto Roku base, altere `DeltaAppId()`, nome/ícones/manifest e gere o pacote. O servidor não precisa de deploy.

Desvincular só é permitido se o app não tiver TVs cadastradas. **Suspender** bloqueia o app inteiro; o parceiro pode **Pausar** o dele.

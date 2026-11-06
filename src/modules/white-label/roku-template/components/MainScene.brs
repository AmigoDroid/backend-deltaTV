' ============================================================
' Delta TV - cena principal: menu lateral + telas + overlays
' ============================================================
sub init()
    m.top.backgroundColor = "0x090B14FF"
    m.top.backgroundURI = ""

    m.sidebar = m.top.findNode("sidebar")
    m.detail = m.top.findNode("detail")
    m.player = m.top.findNode("player")
    m.loading = m.top.findNode("loading")
    m.clockLabel = m.top.findNode("clockLabel")
    m.wifi = m.top.findNode("wifiIcon")
    Txt(m.loading, 20, false, "0xC3C7D8FF")
    Txt(m.clockLabel, 20, true, "0xFFFFFFFF")

    m.screens = []
    ids = ["home", "live", "movies", "series", "favorites", "settings"]
    for each id in ids
        s = m.top.findNode(id)
        m.screens.push(s)
        s.observeField("openItem", "onOpenItem")
        s.observeField("playItem", "onPlayItem")
        s.observeField("navigateTo", "onNavigateTo")
        s.observeField("favoritesChanged", "onFavoritesChanged")
    end for
    live = m.top.findNode("live")
    live.observeField("miniItem", "onMiniItem")
    live.observeField("fullscreenRequest", "onFullscreenRequest")
    m.top.findNode("settings").observeField("reloadCatalog", "onReloadCatalog")
    m.top.findNode("settings").observeField("openConnect", "onOpenConnect")
    m.top.findNode("settings").observeField("addList", "onAddList")
    m.top.findNode("settings").observeField("listsChanged", "onListsChanged")
    m.connect = m.top.findNode("connect")
    m.connect.observeField("closeRequest", "onConnectClose")
    m.connect.observeField("connected", "onReloadCatalog")

    m.sidebar.observeField("itemSelected", "onSidebarSelected")
    m.detail.observeField("closeRequest", "onDetailClose")
    m.detail.observeField("playItem", "onPlayItem")
    m.detail.observeField("favoritesChanged", "onFavoritesChanged")
    m.player.observeField("closeRequest", "onPlayerClose")
    m.top.observeField("inputData", "onDeepLink")
    m.top.observeField("launchArgs", "onDeepLink")
    m.top.observeField("memoryEvent", "onMemoryEvent")

    ' MAC virtual (gerado a partir do ID do aparelho) no rodape do menu
    m.sidebar.macText = DeltaGetIdentity().mac
    m.sidebar.versionText = DeltaAppVersion()

    m.clock = m.top.findNode("clockTimer")
    m.clock.observeField("fire", "onClockTick")
    m.clock.control = "start"
    m.licenseTimer = m.top.findNode("licenseTimer")
    m.licenseTimer.observeField("fire", "onLicenseTimer")
    ' listas guardadas: sem sessao ativa mas com listas (ex.: app fechado no meio de "Adicionar lista"), volta para uma delas
    if not DeltaWhiteLabelMode() then
        if not ListsHasSession() then ListsRestorePrev()
        ListsSyncActive()
        if RegRead("auth_token") <> "" then m.licenseTimer.control = "start"
    end if
    onClockTick()

    m.preload = invalid ' pre-carregamento de TV ao vivo + filmes + series (memoria local)

    m.licenseCheckBusy = false
    m.listsSyncBusy = false ' sincronizacao das listas do servidor (um MAC pode ter varios parceiros)
    m.syncTick = 0
    m.loadingCatalog = false
    m.index = {}
    m.active = -1
    m.section = invalid ' tela ativa aberta (TV ao vivo / Filmes / Séries)
    m.sectionIdx = -1
    m.sectionFrom = "sidebar"
    m.zone = "sidebar"
    m.prevZone = "content"
    m.dialogBeacon = false ' true enquanto a tela de conexao inicial (antes da home) esta aberta
    m.pendingDeepLink = invalid
    m.deepLinkTask = invalid

    if not DeltaWhiteLabelMode() then loadCatalog()
    showScreen(0)
    startWhiteLabelAppearance()
    focusSidebar()
    if DeltaWhiteLabelMode() then
        m.wlTick = 0
        m.licenseTimer.control = "start"
        if RegRead("wl_session") = "" then
            m.zone = "connect"
            m.connect.visible = true
            m.connect.callFunc("focusContent")
            m.dialogBeacon = true
            m.top.signalBeacon("AppDialogInitiate")
        else
            startWhiteLabelStatus()
        end if
        return
    end if
    ' Sem sessão local, iniciar o fluxo de conexão/ativação ao abrir o app.
    if RegRead("auth_token") = "" and RegRead("refresh_token") = "" and not IsCertificationDemoLaunch(m.top.launchArgs) then
        m.zone = "connect"
        m.connect.visible = true
        m.connect.callFunc("focusContent")
        m.dialogBeacon = true
        m.top.signalBeacon("AppDialogInitiate")
    else
        m.licenseTimer.control = "start"
        m.top.signalBeacon("AppLaunchComplete")
        fireAuthenticatedPixel()
    end if
    if IsCertificationDemoLaunch(m.top.launchArgs) then PlayCertificationDemo(m.top.launchArgs)
end sub


' --- Roku appearance engine: published theme / offline last-known-good cache ---
sub startWhiteLabelAppearance()
    key = DeltaWhiteLabelAppKey()
    if key = "" then return
    if RegRead("wl_appearance_app_key") <> key then
        RegDelete("wl_appearance_v1")
        RegDelete("wl_appearance_version")
        RegWrite("wl_appearance_app_key", key)
    end if
    applyWhiteLabelAppearance()
    m.appearanceTimer = m.top.findNode("appearanceTimer")
    m.appearanceTimer.observeField("fire", "refreshWhiteLabelAppearance")
    m.appearanceTimer.control = "start"
    refreshWhiteLabelAppearance()
end sub

sub refreshWhiteLabelAppearance()
    key = DeltaWhiteLabelAppKey()
    if key = "" then return
    m.appearanceTask = CreateObject("roSGNode", "AppearanceTask")
    if m.appearanceTask = invalid then return
    m.appearanceTask.appKey = key
    m.appearanceTask.observeField("result", "onWhiteLabelAppearance")
    m.appearanceTask.control = "RUN"
end sub

sub onWhiteLabelAppearance(event as Object)
    data = event.getData()
    if data = invalid then return
    if data.ok <> true then return
    payload = data.data
    if type(payload) <> "roAssociativeArray" then return
    if payload.schema <> 1 then return
    if ToText(payload.appKey) <> DeltaWhiteLabelAppKey() then return
    if type(payload.config) <> "roAssociativeArray" then return
    config = payload.config
    if ToText(config.brandName) = "" or ToText(config.template) = "" then return
    ' Only known layouts may be rendered. Unknown schemas leave the old cache intact.
    if config.template <> "classic" and config.template <> "cinema" and config.template <> "compact" then return
    version = Val(ToText(payload.version))
    oldVersion = Val(RegRead("wl_appearance_version"))
    if version < oldVersion then return
    if version = oldVersion and WLAppearance() <> invalid then return
    RegWrite("wl_appearance_v1", FormatJson(config))
    RegWrite("wl_appearance_version", ToText(payload.version))
    applyWhiteLabelAppearance()
end sub

sub applyWhiteLabelAppearance()
    color = Theme().bg
    m.top.backgroundColor = color
    m.top.findNode("sceneBackground").color = color
    m.sidebar.appearanceVersion = m.sidebar.appearanceVersion + 1
    m.top.findNode("home").appearanceVersion = m.top.findNode("home").appearanceVersion + 1
end sub

' Certificacao 4.3: marketing pixel Roku_Authenticated (uma vez por execucao, quando ha sessao autenticada)
' Roku Event Dispatcher (RED): cria o AnalyticsNode e guarda em m.global
sub initRed()
    RAC = CreateObject("roSGNode", "Roku_Analytics:AnalyticsNode")
    if RAC = invalid then return
    m.global.addFields({ roku_event_dispatcher: RAC })
    RAC.init = { RED: {} }
end sub

sub fireAuthenticatedPixel()
    if m.authPixelFired = true then return
    m.authPixelFired = true
    if m.global.roku_event_dispatcher = invalid then initRed()
    RAC = m.global.roku_event_dispatcher
    if RAC <> invalid then RAC.trackEvent = { RED: { eventName: "Roku_Authenticated" } }
end sub

' ---------- relogio / rede ----------
sub onClockTick()
    m.clockLabel.text = ClockText()
    di = CreateObject("roDeviceInfo")
    if di.GetLinkStatus() then
        m.wifi.opacity = 1.0
    else
        m.wifi.opacity = 0.35
    end if
end sub

' Revalida o estado da licença periodicamente, inclusive durante a reprodução direta no fornecedor.
sub onLicenseTimer()
    if DeltaWhiteLabelMode() then
        m.wlTick = m.wlTick + 1
        if (m.wlTick mod 5) = 0 and RegRead("wl_session") <> "" then startWhiteLabelStatus()
        return
    end if
    ' retoma o pre-carregamento interrompido por pouca memoria (so baixa os tipos que ainda faltam)
    if m.memRetry = true and m.preload = invalid and m.goodCatalog <> invalid then
        if m.goodCatalog.lazy = true and not MemTight(70) then
            m.memRetry = false
            print "[Mem] memoria aliviou: retomando pre-carregamento"
            startPreload()
        end if
    end if
    if m.licenseCheckBusy = true then return
    if RegRead("auth_token") = "" then return
    m.licenseCheckBusy = true
    m.licenseTask = CreateObject("roSGNode", "SetupTask")
    m.licenseTask.params = {
        action: "status",
        accessToken: RegRead("auth_token"),
        refreshToken: RegRead("refresh_token")
    }
    m.licenseTask.observeField("result", "onLicenseCheckResult")
    m.licenseTask.control = "RUN"
end sub

sub startWhiteLabelStatus()
    if m.wlBusy = true then return
    m.wlBusy = true
    m.wlAuthTask = CreateObject("roSGNode", "WhiteLabelAuthTask")
    m.wlAuthTask.params = {action:"session"}
    m.wlAuthTask.observeField("result", "onWhiteLabelStatus")
    m.wlAuthTask.control = "RUN"
end sub

sub onWhiteLabelStatus(event as Object)
    m.wlBusy = false
    result = event.getData()
    if result <> invalid and result.ok = true then
        if m.goodCatalog = invalid then loadCatalog()
        if m.dialogBeacon <> true then m.top.signalBeacon("AppLaunchComplete")
        fireAuthenticatedPixel()
        return
    end if
    clear = result = invalid
    if result <> invalid then clear = result.clearAuth = true
    lastCheck = Val(RegRead("wl_last_authorized"))
    if lastCheck > 0 and CreateObject("roDateTime").AsSeconds() - lastCheck > 1200 then clear = true
    if not clear then return
    RegDelete("wl_session")
    RegDelete("wl_cfg")
    XtClearCatalogCache()
    dropStore()
    video = m.player.findNode("video")
    if video <> invalid then video.control = "stop"
    m.player.visible = false
    hideSection()
    m.goodCatalog = invalid
    m.connect.visible = true
    m.zone = "connect"
    m.connect.callFunc("focusContent")
end sub

sub onLicenseCheckResult(event as Object)
    if not event.getRoSGNode().isSameNode(m.licenseTask) then return
    result = event.getData()
    m.licenseCheckBusy = false
    if result = invalid then return
    if result.accessToken <> invalid and result.accessToken <> "" then RegWrite("auth_token", result.accessToken)
    if result.refreshToken <> invalid and result.refreshToken <> "" then RegWrite("refresh_token", result.refreshToken)

    blocked = result.clearAuth = true or (result.ok = true and result.allowed = false) or result.status = "expired" or result.status = "disabled" or result.status = "deactivated"
    if blocked then
        ' um MAC pode ter varios parceiros: se outra lista guardada estiver em dia, troca para ela em vez de cair na conexao
        if tryFallbackList(result) then return
        RegDelete("auth_token")
        RegDelete("refresh_token")
        RegDelete("xt_cfg")
        XtClearCatalogCache()
        dropStore()
        v = m.player.findNode("video")
        if v <> invalid then v.control = "stop"
        m.player.visible = false
        hideSection()
        m.licenseTimer.control = "stop"
        m.goodCatalog = invalid
        m.connect.visible = true
        m.zone = "connect"
        m.connect.callFunc("focusContent")
        return
    end if

    ' A cada ~5 verificacoes (e na primeira), confere no servidor se surgiram/sumiram listas deste MAC.
    m.syncTick = m.syncTick + 1
    if result.ok = true and (m.syncTick mod 5) = 1 then startListsSync()

    ' Só invalida o catálogo quando a configuração da ativação realmente mudou no painel.
    if result.ok = true then
        version = ToText(result.configurationVersion)
        previousVersion = RegRead("configuration_version")
        if version <> "" then RegWrite("configuration_version", version)
        if previousVersion <> "" and version <> "" and previousVersion <> version then
            RegDelete("xt_cfg")
            XtClearCatalogCache()
            dropStore()
            v = m.player.findNode("video")
            if v <> invalid then v.control = "stop"
            m.player.visible = false
            if m.loadingCatalog <> true then loadCatalog()
        end if
    end if
end sub

' ---------- varias listas por MAC ----------
' A lista em uso caiu (sessao invalida) ou ficou bloqueada/expirada. Havendo outra lista guardada e utilizavel, troca para ela.
' Retorna true se trocou (o catalogo da nova lista ja foi pedido).
function tryFallbackList(result as Object) as Boolean
    if ListsLoad().count() < 2 then return false
    deadId = RegRead("active_list")
    if deadId = "" then return false
    if result.clearAuth = true then
        ListsRemove(deadId) ' sessao invalida: a lista nao existe mais no servidor
    else
        st = ToText(result.status)
        if st <> "expired" and st <> "disabled" and st <> "deactivated" then st = "disabled"
        RegWrite("configuration_status", st) ' fica guardado como indisponivel e a troca automatica a pula
        ListsSyncActive()
    end if
    if not ListsActivateNextUsable(deadId) then return false
    resetForListChange()
    XtClearCatalogCache()
    m.licenseTimer.control = "start"
    loadCatalog()
    return true
end function

' Consulta o servidor: traz listas novas (parceiro adicionado pelo painel) e tira as que foram removidas.
sub startListsSync()
    if m.listsSyncBusy = true then return
    if RegRead("auth_token") = "" then return
    ListsSyncActive()
    lists = ListsLoad()
    known = []
    for each e in lists
        if ToText(e.activationId) <> "" then known.push(ToText(e.activationId))
    end for
    m.listsSyncBusy = true
    m.listsTask = CreateObject("roSGNode", "ListsTask")
    m.listsTask.params = {
        accessToken: RegRead("auth_token"),
        knownIds: known,
        ignoredIds: ListsIgnoredLoad(),
        slots: ListsMax() - lists.count()
    }
    m.listsTask.observeField("result", "onListsSyncResult")
    m.listsTask.control = "RUN"
end sub

sub onListsSyncResult(event as Object)
    if m.listsTask = invalid then return
    if not event.getRoSGNode().isSameNode(m.listsTask) then return
    r = event.getData()
    m.listsSyncBusy = false
    m.listsTask = invalid
    if r = invalid or r.ok <> true then return
    ListsSyncActive()
    ListsMergeServer(r.lists)
    dropped = ListsDropMissing(r.serverIds)
    if dropped.activeRemoved then
        ' a lista em uso foi removida no servidor: usa outra (ou abre a conexao se nao houver)
        ListsActivateNextUsable("")
        onListsChanged()
    end if
end sub

' ---------- catalogo ----------
sub loadCatalog()
    if m.loadingCatalog = true then return ' ja existe um download em andamento: nao baixa de novo
    m.loadingCatalog = true
    m.loading.visible = true
    m.task = CreateObject("roSGNode", "ContentTask")
    m.task.observeField("result", "onCatalogLoaded")
    m.task.control = "RUN"
end sub

sub onReloadCatalog()
    loadCatalog()
end sub

sub onCatalogLoaded(event as Object)
    cat = event.getData()
    if cat = invalid then return
    m.loadingCatalog = false

    ' Falha de uma nova tentativa nao pode apagar o catalogo que ja foi baixado e esta na tela.
    total = cat.channels.count() + cat.movies.count() + cat.series.count()
    if total = 0 and cat.lazy <> true and m.goodCatalog <> invalid and cat.clearAuth <> true then
        m.loading.visible = false
        return
    end if
    if total > 0 or cat.lazy = true then m.goodCatalog = cat

    if cat.accessToken <> invalid and cat.accessToken <> "" then RegWrite("auth_token", cat.accessToken)
    if cat.accessToken <> invalid and cat.accessToken <> "" then m.licenseTimer.control = "start"
    if cat.refreshToken <> invalid and cat.refreshToken <> "" then RegWrite("refresh_token", cat.refreshToken)
    if cat.clearAuth = true then
        ' sessao da lista em uso caiu (ex.: parceiro removido no painel): usa outra lista guardada, se houver
        if tryFallbackList({ clearAuth: true, status: "" }) then return
        RegDelete("auth_token")
        RegDelete("xt_cfg")
        RegDelete("refresh_token")
        m.licenseTimer.control = "stop"
        XtClearCatalogCache()
        dropStore()
        ' A licença foi revogada/bloqueada ou a sessão deixou de ser válida: não manter reprodução/catálogo antigo.
        v = m.player.findNode("video")
        if v <> invalid then v.control = "stop"
        m.player.visible = false
        hideSection()
        m.connect.visible = true
        m.zone = "connect"
        m.connect.callFunc("focusContent")
    end if

    m.index = {}
    for each key in ["channels", "movies", "series"]
        for each it in cat[key]
            m.index[it.id] = it
        end for
    end for

    m.loading.visible = false
    for each s in m.screens
        s.catalog = cat
    end for

    ' sessao valida: baixa em segundo plano TV ao vivo, filmes e series para a memoria
    if cat.clearAuth <> true and cat.lazy = true then startPreload()
    TryPendingDeepLink()
end sub

' ---------- memoria do catalogo ----------
' O cache local (tmp:/dtv_*) e apagado junto com XtClearCatalogCache(); aqui so se interrompe o download em andamento.
sub dropStore()
    if m.preload <> invalid then
        m.preload.control = "stop"
        m.preload = invalid
    end if
end sub

sub startPreload()
    dropStore()
    ' NAO limpa: o catalogo salvo (cachefs:/) abre na hora; o PreloadTask so baixa o que estiver velho (>6 h) ou de outra lista.
    m.preload = CreateObject("roSGNode", "PreloadTask")
    m.preload.observeField("result", "onPreloadDone")
    m.preload.control = "RUN"
end sub

sub onPreloadDone(event as Object)
    if m.preload = invalid then return
    if not event.getRoSGNode().isSameNode(m.preload) then return
    r = event.getData()
    m.preload = invalid
    if r <> invalid and r.clearAuth = true then XtMemClear()
end sub

' ---------- navegacao ----------
' Telas do menu lateral (Início, Favoritos, Configurações): ficam ao lado do menu.
sub showScreen(idx as Integer)
    for each i in [0, 4, 5]
        m.screens[i].visible = (i = idx)
    end for
    m.active = idx
    m.sidebar.activeIndex = idx
end sub

' Telas ativas (1 = TV ao vivo, 2 = Filmes, 3 = Séries): abrem em tela cheia por cima do menu.
' from = de onde veio ("sidebar" ou "content"): VOLTAR devolve o foco para la.
sub openSection(idx as Integer, origin as String)
    if m.section <> invalid then return
    m.sectionIdx = idx
    m.sectionFrom = origin
    m.section = m.screens[idx]
    ' esconde o que fica por baixo (para o carrossel da Início e economiza render)
    if m.active >= 0 then m.screens[m.active].visible = false
    m.sidebar.visible = false
    m.section.visible = true
    m.zone = "section"
    m.section.callFunc("focusContent")
end sub

' Fecha a tela ativa sem mexer no foco (usado quando a sessão cai).
sub hideSection()
    if m.section = invalid then return
    ' a miniatura da TV ao vivo não pode continuar tocando depois de sair da tela
    if m.sectionIdx = 1 and m.player.mini = true then
        m.player.callFunc("stopMini")
        m.player.visible = false
    end if
    m.section.visible = false
    m.section = invalid
    m.sectionIdx = -1
    m.sidebar.visible = true
    if m.active >= 0 then m.screens[m.active].visible = true
end sub

sub closeSection()
    if m.section = invalid then return
    origin = m.sectionFrom
    hideSection()
    if origin = "sidebar" then
        focusSidebar()
    else
        focusContent()
    end if
end sub

sub focusSidebar()
    ' Ao abrir o menu, desliga o indicador da Home para nao mostrar dois focos.
    if m.active = 0 and m.section = invalid then
        m.screens[0].callFunc("blurContent")
    end if
    m.zone = "sidebar"
    m.sidebar.callFunc("focusSidebar")
end sub

sub focusContent()
    if m.section <> invalid then
        m.zone = "section"
        m.section.callFunc("focusContent")
    else
        m.zone = "content"
        m.screens[m.active].callFunc("focusContent")
    end if
end sub

sub onSidebarSelected(event as Object)
    idx = event.getData()
    if idx < 0 then return
    if idx >= 1 and idx <= 3 then
        openSection(idx, "sidebar")
    else
        showScreen(idx)
        focusContent()
    end if
end sub

sub onNavigateTo(event as Object)
    idx = event.getData()
    if idx >= 1 and idx <= 3 then
        openSection(idx, "content")
    else
        showScreen(idx)
        focusContent()
    end if
end sub

sub onFavoritesChanged()
    for each s in m.screens
        s.favsVersion = s.favsVersion + 1
    end for
end sub

' ---------- conectar dispositivo ----------
sub onOpenConnect()
    if DeltaWhiteLabelMode() then
        RegDelete("wl_session")
        RegDelete("wl_cfg")
        RegDelete("wl_last_authorized")
        XtClearCatalogCache()
        dropStore()
        v = m.player.findNode("video")
        if v <> invalid then v.control = "stop"
        m.player.visible = false
        hideSection()
        m.goodCatalog = invalid
    end if
    m.zone = "connect"
    m.connect.visible = true
    m.connect.callFunc("focusContent")
end sub

sub onConnectClose()
    if DeltaWhiteLabelMode() then
        if RegRead("wl_session") = "" then
            m.zone = "connect"
            m.connect.visible = true
            m.connect.callFunc("focusContent")
            return
        end if
        m.connect.visible = false
        if m.dialogBeacon then
            m.dialogBeacon = false
            m.top.signalBeacon("AppDialogComplete")
            m.top.signalBeacon("AppLaunchComplete")
        end if
        loadCatalog()
        fireAuthenticatedPixel()
        focusContent()
        return
    end if
    m.connect.visible = false
    if m.dialogBeacon then
        ' fim do dialogo inicial: so entao o canal esta pronto (home visivel)
        m.dialogBeacon = false
        m.top.signalBeacon("AppDialogComplete")
        m.top.signalBeacon("AppLaunchComplete")
    end if
    if ListsHasSession() then
        fireAuthenticatedPixel()
        ListsSyncActive() ' lista nova (ou a mesma de antes) conectada: passa a constar em Configuracoes > Conteudo
        RegDelete("adding_prev")
    else if RegRead("adding_prev") <> "" or ListsLoad().count() > 0 then
        ' VOLTAR na tela de conexao sem concluir: continua com a lista que ja estava em uso
        if ListsRestorePrev() then
            m.goodCatalog = invalid
            m.licenseTimer.control = "start"
            loadCatalog()
        end if
    end if
    focusContent()
    TryPendingDeepLink()
end sub

' Configuracoes > Conteudo > "Adicionar nova lista": abre a tela de conexao (QR) como se o aparelho estivesse sem lista.
sub onAddList()
    if DeltaWhiteLabelMode() then
        onOpenConnect()
        return
    end if
    ListsPrepareAdd() ' guarda a lista atual e deixa o aparelho sem sessao
    resetForListChange()
    m.licenseTimer.control = "stop"
    m.zone = "connect"
    m.connect.visible = true
    m.connect.callFunc("focusContent")
end sub

' Lista trocada / excluida / atualizada manualmente: descarta o que estava carregado e baixa o catalogo da lista em uso.
sub onListsChanged()
    resetForListChange()
    XtClearCatalogCache() ' forca baixar de novo (atualizacao manual e troca de lista)
    if ListsHasSession() then
        m.licenseTimer.control = "start"
        loadCatalog()
    else
        m.licenseTimer.control = "stop"
        m.zone = "connect"
        m.connect.visible = true
        m.connect.callFunc("focusContent")
    end if
end sub

sub resetForListChange()
    dropStore()
    if m.loadingCatalog = true and m.task <> invalid then m.task.control = "stop"
    m.loadingCatalog = false
    m.goodCatalog = invalid
    v = m.player.findNode("video")
    if v <> invalid then v.control = "stop"
    m.player.visible = false
    hideSection()
end sub

' ---------- detalhes / player ----------
sub onOpenItem(event as Object)
    d = event.getData()
    if d = invalid then return
    item = m.index[d.id]
    if item = invalid and d.item <> invalid then item = d.item ' modo paginado: a tela envia o proprio item
    if item = invalid then return

    if item.kind = "channel" then
        startPlayback({
            title: item.title,
            url: item.url,
            playPath: item.playPath,
            playToken: item.playToken,
            streamFormat: item.streamFormat,
            live: true
        })
    else
        m.zone = "detail"
        m.detail.item = item
        m.detail.visible = true
        m.detail.callFunc("focusContent")
    end if
end sub

sub onDetailClose()
    m.detail.visible = false
    focusContent()
end sub

sub onPlayItem(event as Object)
    d = event.getData()
    if d = invalid then return
    startPlayback(d)
end sub

sub startPlayback(d as Object)
    m.prevZone = m.zone
    m.zone = "player"
    m.player.item = d
    m.player.visible = true
    m.player.callFunc("startPlayback")
end sub

' ---------- TV ao vivo: miniatura + tela cheia ----------
sub onMiniItem(event as Object)
    d = event.getData()
    if d = invalid then return
    m.player.item = d
    m.player.visible = true
    m.player.callFunc("startMini") ' o foco continua na lista de canais
end sub

sub onFullscreenRequest()
    m.prevZone = m.zone
    m.zone = "player"
    m.player.callFunc("goFull")
end sub

sub onPlayerClose()
    if m.player.mini <> true then m.player.visible = false ' em miniatura o quadro continua tocando
    if m.prevZone = "detail" then
        m.zone = "detail"
        m.detail.callFunc("focusContent")
    else
        focusContent()
    end if
end sub

' ---------- teclas que ninguem tratou ----------
function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false

    if m.zone = "section" then
        if key = "back" then
            closeSection()
            return true
        end if
    else if m.zone = "content" then
        if key = "left" or key = "back" then
            focusSidebar()
            return true
        end if
    else if m.zone = "sidebar" then
        if key = "back" then
            if m.active <> 0 then
                showScreen(0)
                m.sidebar.callFunc("focusSidebar")
                return true
            end if
            return false ' sai do app
        end if
    end if
    return false
end function

' Conteudo de demonstracao disponivel SOMENTE via deep link de certificacao.
' A Roku usa o MESMO contentId de episodio para mediaType=episode e mediaType=series.
function IsCertificationDemoLaunch(data as Dynamic) as Boolean
    if type(data) <> "roAssociativeArray" then return false
    id = ToText(data.LookupCI("contentId"))
    mt = LCase(ToText(data.LookupCI("mediaType")))
    if (id = "deltatv-demo-bbb" or id = "deltatv-demo-the-goat") and mt = "movie" then return true
    if id = "deltatv-demo-episode-01" and (mt = "episode" or mt = "series") then return true
    ' Alias para testes manuais; no Roku Search, usar o ID do episodio acima.
    if id = "deltatv-demo-series" and mt = "series" then return true
    if id = "deltatv-demo-live" and mt = "livefeed" then return true
    return false
end function

sub PlayCertificationDemo(data as Dynamic)
    if not IsCertificationDemoLaunch(data) then return
    id = ToText(data.LookupCI("contentId"))
    mediaType = LCase(ToText(data.LookupCI("mediaType")))
    m.connect.visible = false
    m.dialogBeacon = false
    if id = "deltatv-demo-live" then
        print "[DeepLink] abrindo HLS linear de demonstracao DeltaTV"
        startPlayback({
            id: id,
            skipResumePrompt: true,
            title: "DeltaTV - Canal de Demonstracao",
            url: "https://deltatv.com.br/demo/live/index.m3u8",
            streamFormat: "hls",
            live: true
        })
    else
        ' Para series: episodio inaugural quando nao assistido; retoma automaticamente se incompleto.
        ' A demo contem 1 episodio; quando concluido, ele reinicia do inicio.
        title = "The Goat (1921) - Buster Keaton"
        demoUrl = "https://deltatv.com.br/demo/videos/the-goat.mp4"
        playId = id
        extra = {}
        if id = "deltatv-demo-episode-01" or id = "deltatv-demo-series" then
            title = "Cosmos Laundromat: First Cycle - Blender Foundation"
            demoUrl = "https://deltatv.com.br/demo/videos/episodio.mp4"
            playId = "deltatv-demo-episode-01"
            extra = {
                seriesRef: "deltatv-demo-series",
                seriesEpisodeId: playId,
                seriesSeason: "1",
                seriesEpisodeNumber: "1"
            }
        end if
        print "[DeepLink] abrindo demonstracao id=" + playId + " mediaType=" + mediaType
        item = {
            id: playId,
            skipResumePrompt: true,
            title: title,
            url: demoUrl,
            streamFormat: "mp4",
            live: false
        }
        for each fieldName in extra
            item[fieldName] = extra[fieldName]
        end for
        ' Os quadros devem estar publicados no servidor: script anexo.
        ' Nunca inventar thumbnails para filmes de fornecedores externos.
        if playId = "deltatv-demo-episode-01" then
            item.thumbnailUrlTemplate = "https://deltatv.com.br/demo/thumbs/episodio/{index}.jpg"
        else
            item.thumbnailUrlTemplate = "https://deltatv.com.br/demo/thumbs/the-goat/{index}.jpg"
        end if
        item.thumbnailInterval = 10
        startPlayback(item)
    end if
end sub

' Extrai seriesRef de IDs estaveis de episodio gerados no DetailScreen:
' ep-me-123-s1-e456  -> serie me-123, episodio 456.
' Aceita tambem me-123 diretamente para testes de series (na Roku Search usar ID do episodio).
function ParseSeriesDeepLink(contentId as String, mediaType as String) as Object
    r = { ok: false, seriesRef: "", seriesId: "", episodeId: "" }
    if Len(contentId) > 235 then return r
    seriesRef = ""
    if Left(contentId, 3) = "ep-" then
        marker = Instr(4, contentId, "-s")
        while marker > 0
            tail = Mid(contentId, marker + 2)
            epMarker = Instr(1, tail, "-e")
            if epMarker > 1 then
                sn = Left(tail, epMarker - 1)
                epId = Mid(tail, epMarker + 2)
                if Val(sn) > 0 and epId <> "" then
                    seriesRef = Mid(contentId, 4, marker - 4)
                    r.episodeId = epId
                    exit while
                end if
            end if
            marker = Instr(marker + 2, contentId, "-s")
        end while
    else if mediaType = "series" then
        seriesRef = contentId
    end if
    delimiter = Instr(1, seriesRef, "-")
    if delimiter <= 1 then return r
    src = Left(seriesRef, delimiter - 1)
    if src <> "me" then return r ' versao atual do app usa um unico fornecedor ativo (me)
    sid = Mid(seriesRef, delimiter + 1)
    if sid = "" or Len(sid) > 70 then return r
    r.ok = true
    r.seriesRef = seriesRef
    r.seriesId = sid
    return r
end function

' Chamadas ao provedor nunca sao feitas na thread da interface.
sub DeepLinkCatalogSeries(data as Object)
    id = ToText(data.LookupCI("contentId"))
    mt = LCase(ToText(data.LookupCI("mediaType")))
    parsed = ParseSeriesDeepLink(id, mt)
    if not parsed.ok then
        print "[DeepLink] identificador de serie/episodio invalido: " + id
        return
    end if
    if RegRead("auth_token") = "" then
        m.pendingDeepLink = data
        print "[DeepLink] aguardando autenticacao para serie"
        return
    end if
    m.pendingDeepLink = invalid
    if m.deepLinkTask <> invalid then m.deepLinkTask.control = "stop"
    m.deepLinkTask = CreateObject("roSGNode", "SeriesDeepLinkTask")
    m.deepLinkTask.request = {
        seriesRef: parsed.seriesRef,
        seriesId: parsed.seriesId,
        episodeId: parsed.episodeId,
        mediaType: mt
    }
    m.deepLinkTask.observeField("result", "onSeriesDeepLinkResult")
    print "[DeepLink] buscando episodios da serie " + parsed.seriesRef + " tipo=" + mt
    m.deepLinkTask.control = "RUN"
end sub

sub onSeriesDeepLinkResult(event as Object)
    if m.deepLinkTask = invalid then return
    if not event.getRoSGNode().isSameNode(m.deepLinkTask) then return
    response = event.getData()
    m.deepLinkTask = invalid
    if type(response) <> "roAssociativeArray" or response.ok <> true then
        print "[DeepLink] nao foi possivel resolver episodio no catalogo atual"
        return
    end if
    print "[DeepLink] episodio escolhido=" + ToText(response.item.id) + " motivo=" + ToText(response.reason)
    startPlayback(response.item)
end sub

sub TryPendingDeepLink()
    if m.pendingDeepLink = invalid then return
    if RegRead("auth_token") = "" then return
    req = m.pendingDeepLink
    m.pendingDeepLink = invalid
    DeepLinkCatalogSeries(req)
end sub

sub onDeepLink(event as Object)
    data = event.getData()
    if type(data) <> "roAssociativeArray" then return
    contentId = ToText(data.LookupCI("contentId"))
    mediaType = LCase(ToText(data.LookupCI("mediaType")))
    if contentId = "" or mediaType = "" then return
    print "[DeepLink] contentId=" + contentId + " mediaType=" + mediaType
    if IsCertificationDemoLaunch(data) then
        PlayCertificationDemo(data)
        return
    end if
    if mediaType = "series" or mediaType = "episode" then
        DeepLinkCatalogSeries(data)
        return
    end if
    ' Listas particulares sao independentes: somente abre se o ID existe no catalogo atual.
    if m.index <> invalid and m.index[contentId] <> invalid then
        item = m.index[contentId]
        if mediaType = "movie" or mediaType = "live" or mediaType = "livefeed" then
            launchItem = {}
            for each itemKey in item
                launchItem[itemKey] = item[itemKey]
            end for
            launchItem.skipResumePrompt = true
            startPlayback(launchItem)
            return
        end if
    end if
    print "[DeepLink] conteudo nao encontrado na lista atual"
end sub

' Pouca memoria (roAppMemoryMonitor / roDeviceInfo): interrompe o pre-carregamento do catalogo, que e o maior consumo.
sub onMemoryEvent(event as Object)
    ev = event.getData()
    evTxt = ""
    if type(ev) = "roAssociativeArray" then evTxt = " (" + ToText(ev.type) + " " + ToText(ev.level) + ")"
    print "[Mem] aviso de memoria" + evTxt
    ' se o pre-carregamento estava rodando, marca para retomar quando a memoria aliviar (max. 3 vezes)
    if m.preload <> invalid then
        if m.memRetries = invalid then m.memRetries = 0
        if m.memRetries < 3 then
            m.memRetries = m.memRetries + 1
            m.memRetry = true
        end if
    end if
    dropStore()
end sub

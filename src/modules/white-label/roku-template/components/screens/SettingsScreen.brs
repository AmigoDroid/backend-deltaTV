sub init()
    t = Theme()
    m.sections = m.top.findNode("sections")
    m.panes = [m.top.findNode("paneDevice"), m.top.findNode("paneContent"), m.top.findNode("paneTmdb"), m.top.findNode("paneKey"), m.top.findNode("paneAbout")]

    Txt(m.top.findNode("header"), 26, true, t.text)
    for each id in ["macTag", "codeTag", "idTag", "srcTag"]
        Txt(m.top.findNode(id), 12, true, t.accentLight)
    end for
    Txt(m.top.findNode("macValue"), 40, true, t.text)
    Txt(m.top.findNode("codeValue"), 24, true, t.text)
    Txt(m.top.findNode("idValue"), 24, true, t.textDim)
    Txt(m.top.findNode("devHint"), 15, false, t.textDim)
    for each id in ["infoModel", "infoOs", "infoNet", "infoIp"]
        Txt(m.top.findNode(id), 16, false, t.textDim)
    end for
    Txt(m.top.findNode("srcValue"), 22, true, t.text)
    Txt(m.top.findNode("srcHint"), 14, false, t.accentLight)
    Txt(m.top.findNode("listsTag"), 12, true, t.accentLight)
    Txt(m.top.findNode("listStatus"), 15, false, t.textDim)
    m.listList = m.top.findNode("listList")
    m.listList.observeField("itemSelected", "onListSelected")
    m.listRows = [] ' o que cada linha da lista faz: { kind: "list"|"add"|"refresh", id }
    m.refreshBusy = false
    m.listFocusIdx = 0
    Txt(m.top.findNode("actStatus"), 15, false, t.textDim)
    Txt(m.top.findNode("keyTag"), 12, true, t.accentLight)
    Txt(m.top.findNode("keyValue"), 52, true, t.text)
    Txt(m.top.findNode("keyInfo"), 15, false, t.textDim)
    Txt(m.top.findNode("keyStatus"), 15, false, t.textDim)
    Txt(m.top.findNode("keyHint"), 14, false, t.accentLight)
    m.keyBusy = false
    m.tmdbList = m.top.findNode("tmdbOptions")
    m.tmdbList.observeField("itemSelected", "onTmdbSelected")
    Txt(m.top.findNode("tmdbTag"), 14, true, t.accentLight)
    Txt(m.top.findNode("tmdbState"), 24, true, t.text)
    Txt(m.top.findNode("tmdbResult"), 15, false, t.accentLight)
    Txt(m.top.findNode("tmdbHint"), 16, false, t.textDim)
    Txt(m.top.findNode("abTmdbTitle"), 19, true, t.accentLight)
    Txt(m.top.findNode("abTmdbNotice"), 15, false, t.textDim)
    Txt(m.top.findNode("abTitle"), 26, true, t.text)
    Txt(m.top.findNode("abVer"), 16, false, t.accentLight)
    m.top.findNode("abVer").text = "Versão " + DeltaAppVersion()
    Txt(m.top.findNode("abText"), 15, false, t.textDim)

    if DeltaWhiteLabelMode() then
        m.sections.content = BuildTextContent(["Dispositivo", "Trocar conta IPTV", "TMDB", "Chave não utilizada", "Sobre"])
    else
        m.sections.content = BuildTextContent(["Dispositivo", "Conteúdo", "TMDB", "Acesso por chave", "Sobre"])
    end if
    MarkSelected(m.sections.content, 0)
    m.zone = "sections"
    m.sectionIdx = 0

    m.sections.observeField("itemFocused", "onSectionFocused")
    m.sections.observeField("itemSelected", "onSectionSelected")
    m.top.observeField("visible", "onVisible")
    fillKeyIdle()

    fillDevice()
    fillContent()
    fillTmdb()
end sub

sub onVisible()
    if m.top.visible then
        ' Nova entrada: sincroniza painel, selecao e foco no primeiro item.
        ' A tela de adicionar lista e uma sobreposicao e nao dispara este reset.
        m.zone = "sections"
        m.sections.jumpToItem = 0
        showSection(0)
        ListsSyncActive()
        fillDevice()
        fillContent()
        fillTmdb()
    else
        fillKeyIdle() ' a chave some da tela ao sair
    end if
end sub

sub onCatalog()
    fillContent()
end sub

' ---------- painel: dispositivo ----------
sub fillDevice()
    id = DeltaGetIdentity()
    m.top.findNode("macValue").text = id.mac
    m.top.findNode("codeValue").text = id.code

    shortId = id.seed
    if Len(shortId) > 10 then shortId = Left(shortId, 4) + "..." + Right(shortId, 4)
    m.top.findNode("idValue").text = shortId

    di = CreateObject("roDeviceInfo")
    m.top.findNode("infoModel").text = "Modelo: " + di.GetModelDisplayName() + " (" + di.GetModel() + ")"

    ver = di.GetOSVersion()
    if type(ver) = "roAssociativeArray" then
        m.top.findNode("infoOs").text = "Roku OS: " + ver.major + "." + ver.minor + " build " + ver.build
    else
        osv = di.GetOsVersion()
        m.top.findNode("infoOs").text = "Roku OS: " + ToText(osv.major) + "." + ToText(osv.minor) + "." + ToText(osv.revision) + " build " + ToText(osv.build)
    end if

    net = "Desconectado"
    ct = di.GetConnectionType()
    if ct = "WiFiConnection" then net = "Wi-Fi"
    if ct = "WiredConnection" then net = "Ethernet"
    m.top.findNode("infoNet").text = "Rede: " + net

    ip = "-"
    addrs = di.GetIPAddrs()
    if addrs <> invalid then
        for each k in addrs
            ip = addrs[k]
            exit for
        end for
    end if
    m.top.findNode("infoIp").text = "Endereço IP: " + ip
end sub

' ---------- painel: conteudo ----------
sub fillContent()
    configurationStatus = RegRead("configuration_status")
    listName = RegRead("list_name")
    if RegRead("auth_token") <> "" then
        kind = "Licença"
        if RegRead("activation_kind") = "partner" then kind = "Parceria"
        if configurationStatus = "expired" then
            m.top.findNode("srcValue").text = "Acesso expirado"
        else if configurationStatus = "disabled" or configurationStatus = "deactivated" then
            m.top.findNode("srcValue").text = "Dispositivo desativado"
        else if configurationStatus = "session_required" then
            m.top.findNode("srcValue").text = "Sessão necessária"
        else if configurationStatus = "awaiting_configuration" then
            m.top.findNode("srcValue").text = "Aguardando configuração"
        else if RegRead("license_pending_configuration") = "true" then
            m.top.findNode("srcValue").text = "Licença ativada; playlist pendente"
        else if configurationStatus = "configured_partner" then
            m.top.findNode("srcValue").text = "Configurado por parceria"
        else if configurationStatus = "configured_playlist" then
            m.top.findNode("srcValue").text = "Configurado por licença Delta"
        else
            m.top.findNode("srcValue").text = "Dispositivo ativado (" + kind + ")"
        end if
        if listName <> "" then m.top.findNode("srcValue").text = m.top.findNode("srcValue").text + ": " + EmojiStrip(listName)
    else if RegRead("registration_token") <> "" then
        m.top.findNode("srcValue").text = "Aguardando configuração pelo QR Code"
    else
        state = RegRead("configuration_status")
        if state = "expired" then
            m.top.findNode("srcValue").text = "Acesso expirado"
        else if state = "disabled" or state = "deactivated" then
            m.top.findNode("srcValue").text = "Dispositivo desativado"
        else if state = "session_required" then
            m.top.findNode("srcValue").text = "Sessão necessária"
        else if state = "awaiting_configuration" then
            m.top.findNode("srcValue").text = "Aguardando configuração"
        else
            m.top.findNode("srcValue").text = "Não conectado"
        end if
    end if

    cat = m.top.catalog
    if cat <> invalid then
        origem = "nenhuma lista"
        if cat.source = "remote" then origem = "sua lista online"
        status = "Carregado de: " + origem + "  •  " + cat.channels.count().toStr() + " canais, " + cat.movies.count().toStr() + " filmes, " + cat.series.count().toStr() + " séries"
        if cat.error <> invalid and cat.error <> "" then status = status + "  •  " + cat.error
        m.top.findNode("actStatus").text = status
    end if
end sub

sub onSectionFocused()
    idx = m.sections.itemFocused
    if idx < 0 or idx >= m.panes.count() then return
    showSection(idx)
end sub

sub showSection(idx as Integer)
    if m.sectionIdx = 3 and idx <> 3 then fillKeyIdle() ' sair do painel apaga a chave da tela
    m.sectionIdx = idx
    if idx = 1 then buildListRows(m.listFocusIdx)
    if idx = 2 then fillTmdb()
    MarkSelected(m.sections.content, idx)
    for i = 0 to m.panes.count() - 1
        m.panes[i].visible = (i = idx)
    end for
end sub

sub onSectionSelected(event as Object)
    if DeltaWhiteLabelMode() and event.getData() = 1 then
        m.top.openConnect = true
        return
    end if
    if DeltaWhiteLabelMode() and event.getData() = 3 then return
    if event.getData() = 1 then focusLists()
    if event.getData() = 2 then focusTmdb()
    if event.getData() = 3 then requestKey()
end sub

' ---------- painel: acesso por chave ----------
sub fillKeyIdle()
    m.top.findNode("keyValue").text = "------"
    m.top.findNode("keyStatus").text = ""
    if RegRead("auth_token") = "" then
        m.top.findNode("keyInfo").text = "Disponível depois que este dispositivo estiver conectado."
        m.top.findNode("keyHint").text = ""
    else
        m.top.findNode("keyInfo").text = "Use esta chave, junto com o MAC deste aparelho, na tela Login de dispositivo do painel para trocar ou remover a lista. Vale por 10 minutos e só pode ser usada uma vez."
        m.top.findNode("keyHint").text = "Pressione OK para gerar uma chave"
    end if
end sub

sub requestKey()
    if m.keyBusy then return
    if RegRead("auth_token") = "" then return
    m.keyBusy = true
    m.top.findNode("keyStatus").text = "Gerando chave..."
    m.keyTask = CreateObject("roSGNode", "DeviceKeyTask")
    m.keyTask.observeField("result", "onKeyResult")
    m.keyTask.control = "RUN"
end sub

sub onKeyResult(event as Object)
    m.keyBusy = false
    r = event.getData()
    if r = invalid then return
    if r.ok then
        k = r.key
        m.top.findNode("keyValue").text = Left(k, 3) + " " + Right(k, 3)
        minutes = Int(r.ttlSeconds / 60)
        m.top.findNode("keyStatus").text = "Válida por " + minutes.toStr() + " minutos. Nova chave invalida a anterior."
    else
        m.top.findNode("keyValue").text = "------"
        msg = r.message
        if r.clearAuth then msg = "Sessão encerrada. Feche e abra o aplicativo."
        m.top.findNode("keyStatus").text = msg
    end if
end sub

' ---------- foco ----------
sub focusContent()
    fillContent()
    if m.zone = "lists" and m.sectionIdx = 1 then
        focusLists()
    else if m.zone = "tmdb" and m.sectionIdx = 2 then
        focusTmdb()
    else
        backToSections()
    end if
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if m.zone = "lists" then
        if key = "left" or key = "back" then
            backToSections()
            return true
        end if
        return false
    end if
    if m.zone = "tmdb" then
        if key = "left" or key = "back" then
            backToSections()
            return true
        end if
        return false
    end if
    if DeltaWhiteLabelMode() and m.sectionIdx = 1 and key = "right" then
        m.top.openConnect = true
        return true
    end if
    if key = "right" and m.sectionIdx = 1 then
        focusLists()
        return true
    else if key = "right" and m.sectionIdx = 2 then
        focusTmdb()
        return true
    end if
    return false
end function

 ' ---------- Configuracoes > TMDB ----------
' Uma unica opcao na tela: habilitar/desabilitar a consulta de metadados.
sub fillTmdb()
    active = (RegRead("tmdb_enabled") = "true")
    if active then
        m.top.findNode("tmdbState").text = "Integração: ATIVADA"
        m.tmdbList.content = BuildTextContent(["Desativar TMDB"])
    else
        m.top.findNode("tmdbState").text = "Integração: DESATIVADA"
        m.tmdbList.content = BuildTextContent(["Ativar TMDB"])
    end if
    m.tmdbList.jumpToItem = 0
end sub

sub focusTmdb()
    fillTmdb()
    m.zone = "tmdb"
    m.tmdbList.setFocus(true)
end sub

sub onTmdbSelected(event as Object)
    if event.getData() <> 0 then return
    if RegRead("tmdb_enabled") = "true" then
        RegWrite("tmdb_enabled", "false")
        m.top.findNode("tmdbResult").text = "TMDB desativado. Informações originais da lista mantidas."
    else
        RegWrite("tmdb_enabled", "true")
        m.top.findNode("tmdbResult").text = "TMDB ativado. Novas consultas ocorrerão ao abrir os detalhes."
    end if
    fillTmdb()
    m.tmdbList.setFocus(true)
end sub

' ---------- painel: listas ----------
' Monta as linhas: uma por lista guardada + "Adicionar nova lista" + "Atualizar listas agora".
sub buildListRows(keepIdx as Integer)
    lists = ListsLoad()
    active = RegRead("active_list")
    titles = []
    m.listRows = []
    for each e in lists
        label = EmojiStrip(ToText(e.name))
        if label = "" then label = "Lista"
        tag = ""
        if ToText(e.id) = active then tag = "  (em uso)"
        st = ListsStateText(ToText(e.state))
        if st <> "" and st <> "pronta" then tag = tag + "  -  " + st
        titles.push(label + tag)
        m.listRows.push({ kind: "list", id: ToText(e.id) })
    end for
    if lists.count() = 0 then
        titles.push("Nenhuma lista cadastrada")
        m.listRows.push({ kind: "none", id: "" })
    end if
    titles.push("+  Adicionar nova lista")
    m.listRows.push({ kind: "add", id: "" })
    titles.push("Atualizar listas agora")
    m.listRows.push({ kind: "refresh", id: "" })
    m.listList.content = BuildTextContent(titles)
    if keepIdx < 0 then keepIdx = 0
    if keepIdx >= titles.count() then keepIdx = titles.count() - 1
    m.listFocusIdx = keepIdx
    m.listList.jumpToItem = keepIdx
end sub

sub focusLists()
    ListsSyncActive()
    buildListRows(m.listFocusIdx)
    m.zone = "lists"
    m.top.findNode("listStatus").text = ""
    m.listList.setFocus(true)
end sub

sub backToSections()
    if m.zone = "lists" and m.listList.itemFocused >= 0 then m.listFocusIdx = m.listList.itemFocused
    m.zone = "sections"
    m.sections.setFocus(true)
end sub

sub onListSelected(event as Object)
    idx = event.getData()
    if idx < 0 or idx >= m.listRows.count() then return
    m.listFocusIdx = idx
    row = m.listRows[idx]
    if row.kind = "add" then
        if ListsLoad().count() >= ListsMax() then
            m.top.findNode("listStatus").text = "Limite de " + ListsMax().toStr() + " listas. Exclua uma para adicionar outra."
            return
        end if
        m.top.addList = true ' a tela de conexao (QR) abre por cima; VOLTAR nela restaura a lista atual
    else if row.kind = "refresh" then
        startListsRefresh()
    else if row.kind = "list" then
        openListMenu(row.id)
    end if
end sub

sub openListMenu(id as String)
    lists = ListsLoad()
    idx = ListsFind(lists, id)
    if idx < 0 then return
    e = lists[idx]
    m.menuId = id
    m.menuName = EmojiStrip(ToText(e.name))
    isActive = (RegRead("active_list") = id)
    btns = []
    if not isActive then btns.push("Usar esta lista")
    btns.push("Excluir lista")
    btns.push("Cancelar")
    msg = "Em uso neste aparelho."
    if not isActive then msg = "Guardada neste aparelho."
    st = ListsStateText(ToText(e.state))
    if st <> "" then msg = msg + " Estado: " + st + "."
    showDialog(m.menuName, [msg], btns, "onListMenu")
end sub

sub showDialog(title as String, message as Object, btns as Object, handler as String)
    dlg = CreateObject("roSGNode", "StandardMessageDialog")
    dlg.title = title
    dlg.message = message
    dlg.buttons = btns
    m.dlgButtons = btns
    dlg.observeFieldScoped("buttonSelected", handler)
    m.dialog = dlg
    m.top.getScene().dialog = dlg
end sub

sub closeDialog()
    if m.dialog <> invalid then m.dialog.close = true
    m.dialog = invalid
    m.listList.setFocus(true)
end sub

sub onListMenu()
    label = m.dlgButtons[m.dialog.buttonSelected]
    closeDialog()
    if label = "Usar esta lista" then
        useList(m.menuId)
    else if label = "Excluir lista" then
        showDialog("Excluir lista?", [Chr(34) + m.menuName + Chr(34) + " será removida deste aparelho."], ["Excluir", "Cancelar"], "onDeleteConfirm")
    end if
end sub

sub onDeleteConfirm()
    label = m.dlgButtons[m.dialog.buttonSelected]
    closeDialog()
    if label = "Excluir" then deleteList(m.menuId)
end sub

sub useList(id as String)
    if not ListsActivate(id) then return
    buildListRows(m.listFocusIdx)
    fillContent()
    m.top.findNode("listStatus").text = "Lista alterada. Carregando o catálogo..."
    m.top.listsChanged = true
end sub

sub deleteList(id as String)
    wasActive = ListsRemoveAndIgnore(id) ' lembra que foi excluida: a sincronizacao com o servidor nao a traz de volta
    if wasActive then
        remaining = ListsLoad()
        if remaining.count() > 0 then ListsActivate(ToText(remaining[0].id))
    end if
    buildListRows(m.listFocusIdx)
    fillContent()
    if wasActive then
        m.top.findNode("listStatus").text = "Lista excluída."
        m.top.listsChanged = true ' sem outra lista: o app abre a tela de conexao
    else
        m.top.findNode("listStatus").text = "Lista excluída."
    end if
end sub

' ---------- atualizar manualmente: consulta o servidor para cada lista guardada ----------
sub startListsRefresh()
    if m.refreshBusy then return
    ListsSyncActive()
    if ListsLoad().count() = 0 then
        m.top.findNode("listStatus").text = "Nenhuma lista para atualizar. Use Adicionar nova lista."
        return
    end if
    m.refreshBusy = true
    m.refIdx = 0
    m.refChanged = false
    m.refOk = 0
    m.refFail = 0
    m.top.findNode("listStatus").text = "Consultando o servidor..."
    refreshNext()
end sub

sub refreshNext()
    lists = ListsLoad()
    while m.refIdx < lists.count()
        e = lists[m.refIdx]
        if ToText(e.accessToken) <> "" or ToText(e.refreshToken) <> "" then exit while
        m.refIdx = m.refIdx + 1
    end while
    if m.refIdx >= lists.count() then
        finishListsRefresh()
        return
    end if
    e = lists[m.refIdx]
    m.refId = ToText(e.id)
    task = CreateObject("roSGNode", "SetupTask")
    task.params = { action: "status", accessToken: ToText(e.accessToken), refreshToken: ToText(e.refreshToken) }
    task.observeField("result", "onListsRefreshResult")
    m.refTask = task
    task.control = "RUN"
end sub

sub onListsRefreshResult(event as Object)
    r = event.getData()
    m.refTask = invalid
    if r = invalid then
        m.refFail = m.refFail + 1
        m.refIdx = m.refIdx + 1
        refreshNext()
        return
    end if
    lists = ListsLoad()
    idx = ListsFind(lists, m.refId)
    if idx >= 0 then
        e = lists[idx]
        isActive = (RegRead("active_list") = m.refId)
        if r.accessToken <> invalid and r.accessToken <> "" then e.accessToken = r.accessToken
        if r.refreshToken <> invalid and r.refreshToken <> "" then e.refreshToken = r.refreshToken
        if r.ok = true then
            m.refOk = m.refOk + 1
            st = ToText(r.configurationStatus)
            if st = "" then st = ToText(r.status)
            if st = "configured" and r.allowed <> true then st = ""
            if st <> "" then e.state = st
            if ToText(r.listName) <> "" then e.name = ToText(r.listName)
            ver = ToText(r.configurationVersion)
            if ver <> "" then
                if ToText(e.cfgVer) <> "" and ToText(e.cfgVer) <> ver then
                    if isActive then m.refChanged = true
                end if
                e.cfgVer = ver
            end if
            if r.status = "expired" or r.status = "disabled" or r.status = "deactivated" then
                if isActive then m.refChanged = true
            end if
        else
            m.refFail = m.refFail + 1
            if r.clearAuth = true then
                e.state = "session_required"
                if isActive then m.refChanged = true
            else
                e.state = "offline"
            end if
        end if
        e.checkedAt = CreateObject("roDateTime").AsSeconds()
        lists[idx] = e
        ListsSave(lists)
        if isActive then
            ' mantem o registro igual ao que acabou de ser confirmado (tokens giram a cada renovacao)
            if ToText(e.accessToken) <> "" then RegWrite("auth_token", e.accessToken)
            if ToText(e.refreshToken) <> "" then RegWrite("refresh_token", e.refreshToken)
            if ToText(e.name) <> "" then RegWrite("list_name", e.name)
            if ToText(e.state) <> "" and e.state <> "offline" then RegWrite("configuration_status", e.state)
            if ToText(e.cfgVer) <> "" then RegWrite("configuration_version", e.cfgVer)
        end if
    end if
    m.refIdx = m.refIdx + 1
    refreshNext()
end sub

sub finishListsRefresh()
    ListsSyncActive()
    ' Um MAC pode ter varios parceiros: depois de conferir cada lista, pergunta ao servidor por listas novas/removidas.
    if RegRead("auth_token") <> "" then
        lists = ListsLoad()
        known = []
        for each e in lists
            if ToText(e.activationId) <> "" then known.push(ToText(e.activationId))
        end for
        m.syncBefore = lists.count()
        task = CreateObject("roSGNode", "ListsTask")
        task.params = {
            accessToken: RegRead("auth_token"),
            knownIds: known,
            ignoredIds: ListsIgnoredLoad(),
            slots: ListsMax() - lists.count()
        }
        task.observeField("result", "onServerSyncResult")
        m.serverSyncTask = task
        task.control = "RUN"
        return
    end if
    finishRefreshUi("")
end sub

sub onServerSyncResult(event as Object)
    r = event.getData()
    m.serverSyncTask = invalid
    note = ""
    if r <> invalid and r.ok = true then
        ListsSyncActive()
        ListsMergeServer(r.lists)
        dropped = ListsDropMissing(r.serverIds)
        added = ListsLoad().count() - m.syncBefore + dropped.removed
        if added > 0 then note = note + "  " + added.toStr() + " lista(s) nova(s) do servidor."
        if dropped.removed > 0 then note = note + "  " + dropped.removed.toStr() + " removida(s) no servidor."
        if dropped.activeRemoved then ListsActivateNextUsable("")
    end if
    finishRefreshUi(note)
end sub

sub finishRefreshUi(note as String)
    m.refreshBusy = false
    ListsSyncActive()
    buildListRows(m.listList.itemFocused)
    fillContent()
    msg = "Listas verificadas: " + m.refOk.toStr() + " ok"
    if m.refFail > 0 then msg = msg + ", " + m.refFail.toStr() + " com problema"
    msg = msg + "." + note + " Atualizando o catálogo..."
    m.top.findNode("listStatus").text = msg
    ' atualizacao manual: baixa de novo o catalogo da lista em uso (ignora o que estava salvo)
    m.top.listsChanged = true
end sub

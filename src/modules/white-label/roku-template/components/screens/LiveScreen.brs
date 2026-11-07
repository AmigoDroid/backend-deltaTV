sub init()
    t = Theme()
    m.cats = m.top.findNode("cats")
    m.chans = m.top.findNode("chans")
    m.count = m.top.findNode("count")
    m.empty = m.top.findNode("empty")

    Txt(m.top.findNode("header"), 26, true, t.text)
    Txt(m.count, 15, false, t.textDim)
    Txt(m.empty, 16, false, t.textDim)
    Txt(m.top.findNode("pvNumber"), 22, true, t.accentLight)
    Txt(m.top.findNode("pvNowTag"), 12, true, t.accentLight)
    Txt(m.top.findNode("pvNow"), 18, true, t.text)
    Txt(m.top.findNode("pvNextTag"), 12, true, t.accentLight)
    Txt(m.top.findNode("pvNext"), 18, false, t.textDim)
    Txt(m.top.findNode("btnLabel"), 18, true, t.text)
    Txt(m.top.findNode("pvHint"), 14, false, t.textMute)
    m.top.findNode("btnBg").blendColor = t.accent

    m.catNames = []
    m.catIdx = 0
    m.zone = "chans"
    m.all = []
    m.shown = []

    ' modo paginado (DeltaLazyCatalog)
    m.lazy = false
    m.seq = 0
    m.busy = false
    m.sources = []
    m.folders = []
    m.folder = invalid
    m.items = []
    m.nextCursor = invalid
    m.lastCursor = ""
    m.retryWhat = ""
    m.favQueue = []
    m.selectTimer = m.top.findNode("selectTimer")
    m.selectTimer.observeField("fire", "onSelectTimer")
    m.retryTimer = m.top.findNode("retryTimer")
    m.retryTimer.observeField("fire", "onRetryTimer")

    m.lazyCat = invalid
    m.top.observeField("visible", "onShown")

    m.playingId = ""
    m.pendingFocusChans = false
    m.cats.observeField("itemSelected", "onCatSelected")
    m.cats.observeField("itemFocused", "onCatFocused")
    m.chans.observeField("itemFocused", "onChanFocused")
    m.chans.observeField("itemSelected", "onChanSelected")
    applyAppearance()
end sub

sub applyAppearance()
    copy = WLScreen("live")
    if copy = invalid then return
    if ToText(copy.heading) <> "" then m.top.findNode("header").text = ToText(copy.heading)
    if ToText(copy.subtitle) <> "" then
        node = m.top.findNode("screenSubtitle")
        node.text = ToText(copy.subtitle)
        Txt(node, 16, false, Theme().text)
    end if
    if ToText(copy.emptyLabel) <> "" and m.shown.count() = 0 then m.empty.text = ToText(copy.emptyLabel)
end sub

sub onCatalog()
    cat = m.top.catalog
    if cat = invalid then return
    if cat.lazy = true then
        ' Telas ocultas nao carregam nada (economiza memoria/CPU no inicio): espera a 1a vez que aparecer.
        m.lazyCat = cat
        if m.top.visible then lazyStart()
        return
    end if
    m.lazy = false
    m.all = cat.channels
    if cat.channels.count() = 0 and cat.error <> invalid and cat.error <> "" then
        m.empty.wrap = true
        m.empty.height = 120
        m.empty.text = cat.error
        m.empty.visible = true
    end if

    m.catNames = ["Todos", "Favoritos"]
    for each c in cat.categories
        m.catNames.push(c)
    end for
    m.cats.content = BuildTextContent(m.catNames)
    ' Abre direto na primeira pasta (ex.: Globo) em vez de montar todos os canais de uma vez.
    first = 0
    if cat.categories.count() > 0 then first = 2
    m.catIdx = first
    m.cats.jumpToItem = first
    MarkSelected(m.cats.content, first)
    applyFilter(0)
end sub

sub onShown()
    if not m.top.visible then m.playingId = "" ' a MainScene para a miniatura ao sair da aba
    if m.top.visible and m.lazyCat <> invalid then lazyStart()
end sub

sub lazyStart()
    cat = m.lazyCat
    m.lazyCat = invalid
    if cat <> invalid then lazyInit(cat)
end sub

sub onFavsVersion()
    if m.all.count() > 0 then applyFilter(m.chans.itemFocused)
end sub

' ---------- filtro por categoria ----------
' modo paginado: so o OK numa pasta carrega os canais (mover o foco apenas navega pela lista)
sub onCatSelected(event as Object)
    if not m.lazy then return
    idx = event.getData()
    if idx < 0 or idx >= m.catNames.count() then return
    m.catIdx = idx
    MarkSelected(m.cats.content, idx)
    m.pendingFocusChans = true
    m.selectTimer.control = "stop"
    lazySelectFolder(idx)
end sub

sub focusChansAfterLoad()
    if not m.pendingFocusChans then return
    m.pendingFocusChans = false
    if m.items.count() = 0 then return
    m.zone = "chans"
    if m.top.isInFocusChain() then m.chans.setFocus(true)
end sub

sub onCatFocused()
    if m.lazy then return
    idx = m.cats.itemFocused
    if idx < 0 or idx = m.catIdx then return
    m.catIdx = idx
    MarkSelected(m.cats.content, idx)
    if m.lazy then
        ' so carrega a pasta quando o foco para (evita uma requisicao por pasta ao rolar a lista)
        m.selectTimer.control = "stop"
        m.selectTimer.control = "start"
    else
        applyFilter(0)
    end if
end sub

sub applyFilter(keepIdx as Integer)
    favs = FavSet()
    name = m.catNames[m.catIdx]
    m.shown = []
    for each ch in m.all
        ok = false
        if m.catIdx = 0 then
            ok = true
        else if m.catIdx = 1 then
            ok = (favs[ch.id] = true)
        else
            ok = (ch.category = name)
        end if
        if ok then m.shown.push(ch)
    end for

    ' "Todos" pode ter milhares de canais: mostra os 300 primeiros (o filtro por pasta mostra tudo da pasta).
    visible = m.shown
    if m.catIdx = 0 and m.shown.count() > 300 then visible = m.shown.slice(0, 300)
    m.chans.content = BuildFlatContent(visible, favs)
    m.empty.visible = (m.shown.count() = 0)
    m.top.findNode("preview").visible = (m.shown.count() > 0)

    if m.shown.count() = 1 then
        m.count.text = "1 canal"
    else
        m.count.text = m.shown.count().toStr() + " canais"
    end if

    if m.shown.count() > 0 then
        if keepIdx < 0 then keepIdx = 0
        if keepIdx > m.chans.content.getChildCount() - 1 then keepIdx = m.chans.content.getChildCount() - 1
        m.chans.jumpToItem = keepIdx
        updatePreview(m.chans.content.getChild(keepIdx))
    end if
end sub

' ---------- canais ----------
sub onChanFocused()
    idx = m.chans.itemFocused
    if idx < 0 then return
    updatePreview(m.chans.content.getChild(idx))
    if m.lazy then lazyMaybeLoadMore(idx)
end sub

sub updatePreview(node as Object)
    if node = invalid then return
    m.top.findNode("pvNumber").text = "CANAL " + node.chNumber
    t = Theme()
    SetEmojiText(m.top.findNode("pvName"), node.title, 28, true, t.text, 480, 36)
    SetEmojiText(m.top.findNode("pvCategory"), node.category, 15, false, t.textDim, 480, 22)
    m.top.findNode("pvNow").text = EmojiStrip(node.nowTitle)
    m.top.findNode("pvNext").text = EmojiStrip(node.nextTitle)
    if node.HDPosterUrl <> "" then
        m.top.findNode("pvArt").uri = node.HDPosterUrl
    else
        m.top.findNode("pvArt").uri = "pkg:/images/tv-ao-vivo.jpg"
    end if
end sub

sub onChanSelected(event as Object)
    node = m.chans.content.getChild(event.getData())
    if node = invalid then return
    d = {
        title: node.title,
        url: node.url,
        playPath: node.playPath,
        playToken: node.playToken,
        streamFormat: node.streamFormat,
        live: true
    }
    if m.lazy then
        if m.playingId = node.itemId then
            m.top.fullscreenRequest = true ' 2o OK no canal que ja esta na miniatura: tela cheia
        else
            m.playingId = node.itemId
            m.top.miniItem = d ' 1o OK: toca na miniatura ao lado
        end if
        return
    end if
    m.top.playItem = d
end sub

sub toggleFavorite()
    idx = m.chans.itemFocused
    node = m.chans.content.getChild(idx)
    if node = invalid then return
    wasFav = FavIsFav(node.itemId)
    nowFav = FavToggle(node.itemId)
    if nowFav = wasFav then
        setState("Não foi possível salvar o favorito. Tente novamente.", false)
        return
    end if
    if m.lazy then node.isFav = nowFav
    m.top.favoritesChanged = true
end sub

' ---------- foco ----------
sub focusContent()
    if m.zone = "cats" then
        m.cats.setFocus(true)
    else if shownCount() > 0 then
        m.zone = "chans"
        m.chans.setFocus(true)
    else
        m.zone = "cats"
        m.cats.setFocus(true)
    end if
end sub

function shownCount() as Integer
    if m.lazy then return m.items.count()
    return m.shown.count()
end function

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false

    if m.zone = "chans" then
        if key = "left" or key = "back" then
            m.zone = "cats" ' VOLTAR: volta as pastas (VOLTAR nas pastas fecha a tela)
            m.cats.setFocus(true)
            return true
        else if key = "options" then
            toggleFavorite()
            return true
        end if
    else
        if key = "OK" and m.lazy and m.retryWhat <> "" and m.empty.visible then
            lazyRetry()
            return true
        end if
        if key = "right" then
            if shownCount() > 0 then
                m.zone = "chans"
                m.chans.setFocus(true)
            end if
            return true
        end if
    end if
    return false
end function

' ================================================================
' Modo paginado (DeltaLazyCatalog = true)
' TV ao vivo -> PASTAS (group-title original do M3U) -> canais da pasta (40 por vez) -> reproducao.
' Nada de baixar/exibir todos os canais: cada pasta e cada pagina sao pedidas sob demanda.
' ================================================================
sub lazyInit(cat as Object)
    m.lazy = true
    m.playToken = ToText(cat.playToken)
    m.sources = cat.sources
    m.folders = []
    m.folder = invalid
    m.items = []
    m.nextCursor = invalid
    m.sourceIdx = 0
    m.retryWhat = ""
    m.seq = m.seq + 1 ' invalida qualquer resposta em voo
    m.catNames = ["Favoritos"]
    m.catIdx = 0
    m.cats.content = BuildTextContent(m.catNames)
    m.chans.content = BuildFlatContent([], FavSet())
    m.empty.wrap = true
    m.empty.height = 120
    m.empty.vertAlign = "top"
    m.top.findNode("preview").visible = false
    m.count.text = ""
    setState("Carregando pastas...", true)
    lazyRequestGroups()
end sub

sub setState(text as String, show as Boolean)
    m.empty.text = text
    m.empty.visible = show
end sub

sub callApi(op as String, path as String, query as Object)
    m.seq = m.seq + 1
    t = CreateObject("roSGNode", "CatalogApiTask")
    t.observeField("result", "onApiResult")
    t.request = { reqId: m.seq, op: op, path: path, query: query }
    m.task = t
    m.busy = true
    t.control = "RUN"
end sub

sub onApiResult(event as Object)
    r = event.getData()
    if r = invalid then return
    if r.reqId <> m.seq then return ' resposta de uma consulta antiga: ignora
    m.busy = false
    if r.op = "groups" then
        lazyOnGroups(r)
    else if r.op = "items" then
        lazyOnItems(r)
    else if r.op = "item" then
        lazyOnFavItem(r)
    end if
end sub

' ---------- pastas ----------
sub lazyRequestGroups()
    if m.sourceIdx >= m.sources.count() then
        lazyFoldersReady()
        return
    end if
    callApi("groups", "groups", { sourceId: m.sources[m.sourceIdx].id, kind: "live" })
end sub

sub lazyOnGroups(r as Object)
    if not r.ok then
        ' uma lista com problema (ex.: fonte mal cadastrada) nao pode esconder as demais: segue para a proxima
        if not r.clearAuth and m.sources.count() > 1 then
            m.sourceIdx = m.sourceIdx + 1
            lazyRequestGroups()
            return
        end if
        lazyFail(r, "groups")
        return
    end if
    if type(r.data.groups) <> "roArray" then
        r.message = "Resposta inválida do servidor."
        lazyFail(r, "groups")
        return
    end if
    m.retryWhat = ""
    src = m.sources[m.sourceIdx]
    for each g in r.data.groups
        if type(g) = "roAssociativeArray" then
            name = FolderName(ToText(g.name))
            if m.sources.count() > 1 and src.name <> "" then name = name + " - " + src.name
            m.folders.push({ id: ToText(g.id), name: name, count: Int(Val(ToText(g.itemCount))), sourceId: src.id })
        end if
    end for
    m.sourceIdx = m.sourceIdx + 1
    lazyRequestGroups()
end sub

sub lazyFoldersReady()
    names = ["Favoritos"]
    for each f in m.folders
        names.push(f.name)
    end for
    m.catNames = names
    m.cats.content = BuildTextContent(names)
    if m.folders.count() = 0 then
        setState("Nenhuma pasta de TV ao vivo nesta lista.", true)
        return
    end if
    ' nada e carregado ate o usuario escolher uma pasta (OK)
    m.catIdx = -1
    setState("Escolha uma pasta e pressione OK", true)
    m.zone = "cats"
    if m.top.isInFocusChain() then m.cats.setFocus(true)
end sub

sub onSelectTimer()
    if m.lazy then lazySelectFolder(m.catIdx)
end sub

sub lazySelectFolder(idx as Integer)
    m.seq = m.seq + 1 ' descarta qualquer resposta em voo da pasta anterior
    m.busy = false
    m.items = []
    m.nextCursor = invalid
    m.retryWhat = ""
    m.retryTimer.control = "stop"
    m.chans.content = BuildFlatContent([], FavSet())
    m.top.findNode("preview").visible = false
    m.count.text = ""
    if idx = 0 then
        lazyLoadFavorites()
        return
    end if
    m.folder = m.folders[idx - 1]
    setState("Carregando canais...", true)
    lazyRequestItems("")
end sub

' ---------- canais da pasta (paginado) ----------
sub lazyRequestItems(cursor as String)
    f = m.folder
    m.lastCursor = cursor
    callApi("items", "items", { sourceId: f.sourceId, kind: "live", groupId: f.id, pageSize: "40", cursor: cursor })
end sub

sub lazyOnItems(r as Object)
    if not r.ok then
        lazyFail(r, "items")
        return
    end if
    if type(r.data.items) <> "roArray" then
        r.message = "Resposta inválida do servidor."
        lazyFail(r, "items")
        return
    end if
    m.retryWhat = ""
    favs = FavSet()
    xfer = invalid
    firstPage = (m.items.count() = 0)
    for each raw in r.data.items
        if type(raw) = "roAssociativeArray" then
            it = lazyItem(raw, m.folder, m.items.count() + 1, xfer)
            m.items.push(it)
            m.chans.content.appendChild(BuildItemNode(it, favs))
        end if
    end for

    m.nextCursor = invalid
    if r.data.nextCursor <> invalid then
        if ToText(r.data.nextCursor) <> "" then m.nextCursor = ToText(r.data.nextCursor)
    end if

    if m.items.count() = 0 then
        custom = WLScreen("live")
        message = "Nenhum canal nesta pasta."
        if custom <> invalid then
            if ToText(custom.emptyLabel) <> "" then message = ToText(custom.emptyLabel)
        end if
        setState(message, true)
        return
    end if
    setState("", false)
    m.top.findNode("preview").visible = true
    total = m.folder.count
    if r.data.total <> invalid then total = Int(Val(ToText(r.data.total)))
    if total < m.items.count() then total = m.items.count()
    if total = 1 then
        m.count.text = "1 canal"
    else
        m.count.text = total.toStr() + " canais"
    end if
    if firstPage then
        m.chans.jumpToItem = 0
        updatePreview(m.chans.content.getChild(0))
        focusChansAfterLoad()
    end if
end sub

sub lazyMaybeLoadMore(idx as Integer)
    if m.busy then return
    if m.nextCursor = invalid then return
    if m.folder = invalid or m.catIdx = 0 then return
    if idx >= m.items.count() - 8 then
        if MemTight(85) then
            print "[Mem] canais: memoria alta, nao carrega mais paginas"
        else
            lazyRequestItems(m.nextCursor)
        end if
    end if
end sub

function lazyItem(raw as Object, f as Object, chNum as Integer, xfer as Dynamic) as Object
    path = GatewayPath(ToText(raw.srcVideo))
    return {
        id: f.sourceId + "-" + ToText(raw.id),
        kind: "channel",
        title: ToText(raw.title),
        description: "",
        poster: ToText(raw.logo),
        backdrop: "",
        yearText: "",
        genreText: "",
        durationText: "",
        ageRating: "",
        url: GatewayUrl(path, m.playToken, xfer),
        playPath: path,
        playToken: m.playToken,
        streamFormat: GuessStreamFormat(path),
        accent: "0x4B3A9EFF",
        number: chNum.toStr(),
        category: f.name,
        nowTitle: "",
        nextTitle: "",
        featured: false,
        seasons: []
    }
end function

' ---------- favoritos (pasta virtual): busca cada item salvo ----------
sub lazyLoadFavorites()
    m.folder = { id: "", name: "Favoritos", count: 0, sourceId: "" }
    m.favQueue = []
    for each fid in FavList()
        parsed = LazyParseFavId(ToText(fid))
        if parsed <> invalid then
            if parsed.kind = "l" then m.favQueue.push(parsed)
        end if
    end for
    if m.favQueue.count() = 0 then
        setState("Nenhum favorito aqui. Use * em um canal para favoritar.", true)
        return
    end if
    setState("Carregando favoritos...", true)
    lazyNextFav()
end sub


sub lazyNextFav()
    if m.favQueue.count() = 0 then
        lazyFavDone()
        return
    end if
    m.favCur = m.favQueue.shift()
    callApi("item", "items/" + m.favCur.itemId, { sourceId: m.favCur.sourceId })
end sub

sub lazyOnFavItem(r as Object)
    if r.ok and r.data <> invalid then
        raw = r.data.item
        if raw <> invalid and type(raw) = "roAssociativeArray" then
            if ToText(raw.kind) = "live" then
                xfer = invalid
                it = lazyItem(raw, { sourceId: m.favCur.sourceId, name: "Favoritos" }, m.items.count() + 1, xfer)
                m.items.push(it)
                m.chans.content.appendChild(BuildItemNode(it, FavSet()))
            end if
        end if
    end if
    lazyNextFav()
end sub

sub lazyFavDone()
    if m.items.count() = 0 then
        setState("Nenhum favorito disponível nesta lista.", true)
        return
    end if
    setState("", false)
    m.top.findNode("preview").visible = true
    m.count.text = m.items.count().toStr() + " favoritos"
    m.chans.jumpToItem = 0
    updatePreview(m.chans.content.getChild(0))
    focusChansAfterLoad()
end sub

' ---------- erros e novas tentativas ----------
sub lazyFail(r as Object, what as String)
    if r.status = 503 and r.code = "CATALOG_PREPARING" then
        setState("Preparando o catálogo desta lista... Isso pode levar alguns minutos na primeira vez.", true)
        m.retryWhat = what
        m.retryTimer.control = "stop"
        m.retryTimer.control = "start"
        return
    end if
    if r.status = 409 and r.code = "CATALOG_VERSION_GONE" and what = "items" then
        lazySelectFolder(m.catIdx) ' o catalogo foi atualizado durante a navegacao: recomeca a pasta
        return
    end if
    msg = r.message
    if r.clearAuth then msg = "Sessão encerrada. Feche e abra o aplicativo."
    if msg = "" then msg = "Não foi possível carregar."
    m.retryWhat = what
    if r.clearAuth then
        m.retryWhat = ""
        setState(msg, true)
    else
        setState(msg + "  Pressione OK para tentar novamente.", true)
    end if
end sub

sub onRetryTimer()
    lazyRetry()
end sub

sub lazyRetry()
    what = m.retryWhat
    if what = "" or m.busy then return
    if what = "groups" then
        setState("Carregando pastas...", true)
        lazyRequestGroups()
    else if what = "items" and m.folder <> invalid then
        setState("Carregando canais...", true)
        lazyRequestItems(m.lastCursor)
    end if
end sub

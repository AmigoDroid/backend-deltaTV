sub init()
    t = Theme()
    m.cats = m.top.findNode("cats")
    m.grid = m.top.findNode("grid")
    m.header = m.top.findNode("header")
    m.catCount = m.top.findNode("catCount")
    m.gridTitle = m.top.findNode("gridTitle")
    m.gridCount = m.top.findNode("gridCount")
    m.hint = m.top.findNode("hint")
    m.empty = m.top.findNode("empty")
    m.searchRing = m.top.findNode("searchRing")
    m.searchFocus = m.top.findNode("searchFocus")
    m.searchIcon = m.top.findNode("searchIcon")
    m.searchLabel = m.top.findNode("searchLabel")
    m.searchHint = m.top.findNode("searchHint")
    m.kbdBox = m.top.findNode("kbdBox")
    m.controlKeys = m.top.findNode("controlKeys")
    m.searchTimer = m.top.findNode("searchTimer")

    Txt(m.searchLabel, 18, false, t.textMute)
    Txt(m.searchHint, 12, false, t.textMute)
    Txt(m.header, 30, true, t.text)
    Txt(m.catCount, 14, false, t.textMute)
    Txt(m.gridCount, 15, false, t.textDim)
    Txt(m.hint, 13, false, t.textMute)
    Txt(m.empty, 20, false, t.textDim)

    m.isSeries = false
    m.lazy = true
    m.lazyCat = invalid
    m.sources = []
    m.sourceIdx = 0
    m.groups = []
    m.legacyGroups = []
    m.group = invalid
    m.catIdx = -1
    m.count = 0
    m.itemById = {}
    m.root = CreateObject("roSGNode", "ContentNode")
    m.nextCursor = invalid
    m.playToken = ""
    m.seq = 0
    m.busy = false
    m.zone = "cats"
    m.pendingFocusGrid = false
    m.retryWhat = ""
    m.favDirty = false

    ' pesquisa ao vivo em todo o catalogo: teclado embutido, cada letra refaz a busca
    m.searchMode = false ' teclado na lateral
    m.searching = false  ' ha texto digitado
    m.searchTerm = ""
    m.searchQuery = ""
    m.searchIdx = 0
    m.searchSeen = {}
    m.lastCatIdx = 0
    m.searchFromGrid = false
    buildKeyboard()
    buildControlKeys()
    m.searchTimer.observeField("fire", "onSearchTimer")

    m.cats.observeField("itemSelected", "onCatSelected")
    m.grid.observeField("itemSelected", "onGridSelected")
    m.grid.observeField("itemFocused", "onGridFocused")
    m.top.observeField("visible", "onShown")
    onAppearance()
end sub

sub onAppearance()
    if m.header = invalid then return
    t = Theme()
    m.top.findNode("catalogBackground").color = t.bg
    m.top.findNode("catalogPanel").color = t.panel
    m.top.findNode("catalogDivider").color = t.accent
    m.searchRing.blendColor = t.accent
    m.top.findNode("searchBg").blendColor = t.panel
    m.searchIcon.blendColor = t.accent
    Txt(m.header, 30, true, t.text)
    Txt(m.catCount, 14, false, t.textDim)
    Txt(m.gridCount, 15, false, t.textDim)
    Txt(m.searchLabel, 18, false, t.text)
    Txt(m.searchHint, 12, false, t.textDim)
    Txt(m.hint, 13, false, t.textDim)
    Txt(m.empty, 20, false, t.textDim)
    Txt(m.top.findNode("catalogSubtitle"), 13, false, t.textDim)
    Txt(m.top.findNode("categoriesHeading"), 15, true, t.text)
    applyKind()
end sub

' cabecalho/legenda conforme o tipo (a tela e criada duas vezes: filmes e series)
sub applyKind()
    m.isSeries = (m.top.kind = "series")
    if m.isSeries then
        m.header.text = "Séries"
        m.hint.text = "OK abrir   •   ↑ na primeira linha: buscar   •   VOLTAR categorias"
    else
        m.header.text = "Filmes"
        m.hint.text = "OK abrir   •   * favoritar   •   ↑ na primeira linha: buscar   •   VOLTAR categorias"
    end if
    copyName = "movies"
    if m.isSeries then copyName = "series"
    screenCopy = WLScreen(copyName)
    if screenCopy <> invalid then
        if ToText(screenCopy.heading) <> "" then m.header.text = ToText(screenCopy.heading)
        if ToText(screenCopy.subtitle) <> "" then m.top.findNode("catalogSubtitle").text = ToText(screenCopy.subtitle)
        if ToText(screenCopy.categoriesLabel) <> "" then m.top.findNode("categoriesHeading").text = ToText(screenCopy.categoriesLabel)
    end if
    updateSearchBar()
end sub

sub setState(text as String, show as Boolean)
    m.empty.text = text
    m.empty.visible = show
end sub

' ---------- catalogo ----------
sub onCatalog()
    applyKind()
    cat = m.top.catalog
    if cat = invalid then return
    if cat.lazy = true then
        ' tela oculta nao carrega nada: espera abrir pela 1a vez
        m.lazyCat = cat
        if m.top.visible then lazyStart()
        return
    end if
    m.lazyCat = invalid
    legacyInit(cat)
end sub

sub onShown()
    if m.top.visible and m.lazyCat <> invalid then lazyStart()
end sub

sub onFavsVersion()
    m.favDirty = true
end sub

sub lazyStart()
    cat = m.lazyCat
    m.lazyCat = invalid
    if cat <> invalid then lazyInit(cat)
end sub

sub resetGrid()
    m.root = CreateObject("roSGNode", "ContentNode")
    m.grid.content = m.root
    keepKbdFocus()
    m.itemById = {}
    m.count = 0
    m.nextCursor = invalid
end sub

sub lazyInit(cat as Object)
    applyKind()
    m.lazy = true
    m.playToken = ToText(cat.playToken)
    m.sources = cat.sources
    m.sourceIdx = 0
    m.groups = []
    m.catIdx = -1
    m.group = invalid
    m.seq = m.seq + 1 ' invalida qualquer resposta em voo
    m.busy = false
    m.retryWhat = ""
    m.zone = "cats"
    m.searching = false
    m.searchTerm = ""
    m.searchTimer.control = "stop"
    setSearchMode(false)
    m.cats.content = BuildTextContent([])
    m.catCount.text = ""
    m.gridCount.text = ""
    SetEmojiText(m.gridTitle, "", 24, true, "0xFFFFFFFF", 780, 34)
    resetGrid()
    setState("Carregando categorias...", true)
    lazyRequestGroups()
end sub

' ---------- chamadas ao provedor (uma Task por requisicao; respostas antigas sao descartadas) ----------
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
    if r.reqId <> m.seq then return ' resposta de uma consulta antiga
    m.busy = false
    if r.op = "groups" then
        lazyOnGroups(r)
    else if r.op = "page" then
        lazyOnPage(r)
    else if r.op = "search" then
        onSearchResult(r)
    end if
end sub

' ---------- categorias ----------
sub lazyRequestGroups()
    if m.sourceIdx >= m.sources.count() then
        groupsReady()
        return
    end if
    kind = "movie"
    if m.isSeries then kind = "series"
    callApi("groups", "groups", { sourceId: m.sources[m.sourceIdx].id, kind: kind })
end sub

sub lazyOnGroups(r as Object)
    if not r.ok then
        ' uma lista com problema nao esconde as demais
        if not r.clearAuth and m.sources.count() > 1 then
            m.sourceIdx = m.sourceIdx + 1
            lazyRequestGroups()
            return
        end if
        fail(r, "groups")
        return
    end if
    if type(r.data.groups) <> "roArray" then
        r.message = "Resposta inválida do servidor."
        fail(r, "groups")
        return
    end if
    m.retryWhat = ""
    src = m.sources[m.sourceIdx]
    for each g in r.data.groups
        if type(g) = "roAssociativeArray" then
            name = FolderName(ToText(g.name))
            if m.sources.count() > 1 and src.name <> "" then name = name + " - " + src.name
            m.groups.push({ id: ToText(g.id), name: name, sourceId: src.id })
        end if
    end for
    m.sourceIdx = m.sourceIdx + 1
    lazyRequestGroups()
end sub

sub groupsReady()
    if m.groups.count() = 0 then
        setState("Nenhuma categoria disponível nesta lista.", true)
        return
    end if
    names = []
    listNames = []
    for each g in m.groups
        names.push(g.name)
        listNames.push(g.name)
    end for
    m.cats.content = BuildTextContent(listNames)
    m.cats.jumpToItem = 0
    if names.count() = 1 then
        m.catCount.text = "1 categoria"
    else
        m.catCount.text = names.count().toStr() + " categorias"
    end if
    ' ja abre a 1a categoria para a grade nao ficar vazia; o foco continua na lista
    selectCategory(0, false)
end sub

' ---------- abrir uma categoria ----------
sub selectCategory(idx as Integer, goToGrid as Boolean)
    if m.lazy then
        if idx < 0 or idx >= m.groups.count() then return
    else
        if idx < 0 or idx >= m.legacyGroups.count() then return
    end if
    m.seq = m.seq + 1 ' descarta resposta em voo da categoria anterior
    m.busy = false
    m.catIdx = idx
    m.lastCatIdx = idx
    m.searching = false
    m.searchTerm = ""
    m.searchTimer.control = "stop"
    setSearchMode(false)
    m.retryWhat = ""
    m.pendingFocusGrid = goToGrid
    MarkSelected(m.cats.content, idx)
    resetGrid()
    m.gridCount.text = ""

    if m.lazy then
        m.group = m.groups[idx]
        SetEmojiText(m.gridTitle, m.group.name, 24, true, "0xFFFFFFFF", 780, 34)
        setState("Carregando...", true)
        requestPage("", "40")
    else
        g = m.legacyGroups[idx]
        SetEmojiText(m.gridTitle, g.name, 24, true, "0xFFFFFFFF", 780, 34)
        appendItems(g.items)
        m.gridCount.text = countText(m.count, false)
        afterFirstPage()
    end if
end sub

sub requestPage(cursor as String, pageSize as String)
    g = m.group
    m.lastCursor = cursor
    m.lastPageSize = pageSize
    if m.isSeries then
        callApi("page", "series", { sourceId: g.sourceId, groupId: g.id, pageSize: pageSize, cursor: cursor })
    else
        callApi("page", "items", { sourceId: g.sourceId, kind: "movie", groupId: g.id, pageSize: pageSize, cursor: cursor })
    end if
end sub

sub lazyOnPage(r as Object)
    if not r.ok then
        fail(r, "page")
        return
    end if
    list = r.data.items
    if m.isSeries then list = r.data.series
    if type(list) <> "roArray" then list = []

    first = (m.count = 0)
    items = []
    for each raw in list
        if type(raw) = "roAssociativeArray" then items.push(lazyCatItem(raw, m.group))
    end for
    appendItems(items)

    m.nextCursor = invalid
    if r.data.nextCursor <> invalid then
        if ToText(r.data.nextCursor) <> "" then m.nextCursor = ToText(r.data.nextCursor)
    end if

    total = -1
    if r.data.total <> invalid then total = Int(Val(ToText(r.data.total)))
    if total >= 0 then
        m.gridCount.text = countText(total, false)
    else
        m.gridCount.text = countText(m.count, (m.nextCursor <> invalid))
    end if

    if first then afterFirstPage()
end sub

' cria os nos leves da grade e acrescenta tudo de uma vez (uma unica atualizacao da tela)
sub appendItems(items as Object)
    favs = FavSet()
    nodes = []
    for each it in items
        m.itemById[it.id] = it
        n = CreateObject("roSGNode", "ContentNode")
        n.title = it.title
        n.HDPosterUrl = it.poster
        isFav = false
        if favs[it.id] = true then isFav = true
        n.addFields({ itemId: it.id, kind: it.kind, isFav: isFav })
        nodes.push(n)
    end for
    if nodes.count() > 0 then m.root.appendChildren(nodes)
    m.count = m.root.getChildCount()
end sub

sub afterFirstPage()
    if m.count = 0 then
        screenName = "movies"
        if m.isSeries then screenName = "series"
        custom = WLScreen(screenName)
        message = "Nenhum conteúdo nesta categoria."
        if custom <> invalid then
            if ToText(custom.emptyLabel) <> "" then message = ToText(custom.emptyLabel)
        end if
        setState(message, true)
        m.pendingFocusGrid = false
        return
    end if
    setState("", false)
    m.grid.jumpToItem = 0
    if m.pendingFocusGrid then
        m.pendingFocusGrid = false
        focusGrid()
    end if
end sub

function countText(n as Integer, more as Boolean) as String
    word = " títulos"
    if n = 1 then word = " título"
    s = n.toStr()
    if more then s = s + "+"
    return s + word
end function

function lazyCatItem(raw as Object, g as Object) as Object
    it = {
        id: g.sourceId + "-" + ToText(raw.id),
        kind: "movie",
        title: ToText(raw.title),
        description: "",
        poster: ToText(raw.logo),
        backdrop: "",
        yearText: "",
        genreText: g.name,
        durationText: "",
        ageRating: "",
        url: "",
        playPath: "",
        playToken: m.playToken,
        streamFormat: "hls",
        accent: "0x4B3A9EFF",
        number: "",
        category: g.name,
        nowTitle: "",
        nextTitle: "",
        featured: false,
        seasons: [],
        sourceId: g.sourceId,
        seriesId: "",
        lazySeries: false
    }
    if m.isSeries then
        it.kind = "series"
        it.seriesId = ToText(raw.id)
        it.lazySeries = true
        if Int(Val(ToText(raw.seasonCount))) > 0 then it.durationText = ToText(raw.seasonCount) + " temp."
    else
        path = GatewayPath(ToText(raw.srcVideo))
        it.url = GatewayUrl(path, m.playToken, invalid)
        it.playPath = path
        it.streamFormat = GuessStreamFormat(path)
    end if
    return it
end function

' ---------- modo legado (catalogo completo em memoria; so depuracao) ----------
sub legacyInit(cat as Object)
    applyKind()
    m.lazy = false
    items = cat.movies
    if m.isSeries then items = cat.series

    byGenre = {}
    order = []
    for each it in items
        g = it.genreText
        if g = "" then g = "Outros"
        if not byGenre.DoesExist(g) then
            byGenre[g] = []
            order.push(g)
        end if
        byGenre[g].push(it)
    end for
    m.legacyGroups = []
    names = []
    for each g in order
        m.legacyGroups.push({ name: g, items: byGenre[g] })
        names.push(g)
    end for
    listNames = []
    for each n in names
        listNames.push(n)
    end for
    m.cats.content = BuildTextContent(listNames)
    m.cats.jumpToItem = 0
    m.catCount.text = names.count().toStr() + " categorias"
    m.catIdx = -1
    resetGrid()
    if names.count() = 0 then
        msg = "Nenhum conteúdo disponível."
        if cat.error <> invalid and cat.error <> "" then msg = cat.error
        setState(msg, true)
        return
    end if
    selectCategory(0, false)
end sub

' ---------- selecao / foco ----------
sub onCatSelected(event as Object)
    openListItem(event.getData())
end sub

' A lista lateral contem somente categorias, com indices diretos.
sub openListItem(listIdx as Integer)
    openCategory(listIdx)
end sub

sub openCategory(idx as Integer)
    if idx < 0 then return
    if idx = m.catIdx and m.count > 0 then
        focusGrid() ' ja carregada: so entra na grade (instantaneo)
    else if idx = m.catIdx and m.busy then
        m.pendingFocusGrid = true ' ainda carregando: entra na grade quando chegar
    else
        selectCategory(idx, true)
    end if
end sub

sub focusGrid()
    if m.count = 0 then return
    m.zone = "grid"
    updateSearchBar()
    updateKeyCursor()
    if m.top.isInFocusChain() then m.grid.setFocus(true)
end sub

sub focusSearchBar()
    m.pendingFocusGrid = false
    m.zone = "searchbar"
    updateSearchBar()
    updateKeyCursor()
    m.searchFocus.setFocus(true)
end sub

sub focusCats()
    m.pendingFocusGrid = false
    m.zone = "cats"
    updateSearchBar()
    updateKeyCursor()
    m.cats.setFocus(true)
end sub

' atualizar a grade nao pode tirar o foco do teclado enquanto se digita
sub keepKbdFocus()
    if not m.top.visible or not m.top.isInFocusChain() then return
    if m.searchMode and m.zone = "kbd" then m.kbdBox.setFocus(true)
    if m.zone = "searchbar" then m.searchFocus.setFocus(true)
end sub

sub focusKbd()
    m.pendingFocusGrid = false
    m.zone = "kbd"
    updateSearchBar()
    updateKeyCursor()
    ' o foco fica no proprio grupo do teclado (a lista de categorias, mesmo escondida, nao pode ficar com ele:
    ' ela consome CIMA/BAIXO); as teclas sobem dele ate o onKeyEvent da tela
    m.kbdBox.setFocus(true)
end sub

sub focusContent()
    applyKind()
    if m.searchMode then setSearchMode(true) ' applyKind restaura textos do modo normal
    if m.favDirty then refreshFavs()
    if m.zone = "grid" and m.count > 0 then
        m.grid.setFocus(true)
    else if m.zone = "searchbar" then
        m.searchFocus.setFocus(true)
    else if m.zone = "kbd" then
        m.kbdBox.setFocus(true)
    else
        m.zone = "cats"
        m.cats.setFocus(true)
    end if
    updateSearchBar()
end sub

' favoritos mudaram em outra tela (detalhes): atualiza os coracoes ao voltar
sub refreshFavs()
    m.favDirty = false
    favs = FavSet()
    for i = 0 to m.root.getChildCount() - 1
        n = m.root.getChild(i)
        v = false
        if favs[n.itemId] = true then v = true
        if n.isFav <> v then n.isFav = v
    end for
end sub

sub onGridSelected(event as Object)
    ' Ignore queued selections after focus moved to the search bar or keyboard.
    if m.zone <> "grid" or not m.grid.hasFocus() or not m.top.visible then return
    node = m.root.getChild(event.getData())
    if node = invalid then return
    m.top.openItem = { id: node.itemId, kind: node.kind, item: m.itemById[node.itemId] }
end sub

' perto do fim da grade: busca a proxima pagina da categoria
sub onGridFocused()
    idx = m.grid.itemFocused
    if idx < 0 then return
    if not m.searchMode and m.lazy and m.nextCursor <> invalid and not m.busy and idx >= m.count - 15 then
        ' memoria quase no limite: nao acumula mais itens na grade (a pesquisa/outra categoria continuam funcionando)
        if MemTight(85) then
            print "[Mem] grade: memoria alta, nao carrega mais paginas"
        else
            requestPage(m.nextCursor, "60")
        end if
    end if
end sub

sub toggleFavorite()
    if m.isSeries then return ' favoritos de series ainda nao aparecem na tela Favoritos
    node = m.root.getChild(m.grid.itemFocused)
    if node = invalid then return
    node.isFav = FavToggle(node.itemId)
    m.top.favoritesChanged = true
end sub

' ---------- erros ----------
sub fail(r as Object, what as String)
    if r.clearAuth then
        m.retryWhat = ""
        setState("Sessão encerrada. Feche e abra o aplicativo.", true)
        return
    end if
    if what = "page" and m.count > 0 then
        ' falha ao buscar mais itens: mantem a grade; tenta de novo quando o foco chegar ao fim
        m.retryWhat = ""
        return
    end if
    msg = r.message
    if msg = "" then msg = "Não foi possível carregar."
    m.retryWhat = what
    setState(msg + "  Pressione OK para tentar novamente.", true)
end sub

sub retry()
    what = m.retryWhat
    if what = "" or m.busy then return
    m.retryWhat = ""
    if what = "groups" then
        setState("Carregando categorias...", true)
        lazyRequestGroups()
    else if what = "page" and m.group <> invalid then
        setState("Carregando...", true)
        requestPage(m.lastCursor, m.lastPageSize)
    end if
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false

    if m.searchMode then
        ' teclado fisico / teclado do app Roku
        if Left(key, 4) = "Lit_" then
            ch = Mid(key, 5)
            if ch = "%20" then ch = " "
            if Len(ch) = 1 then
                if Asc(ch) >= 32 then addChar(ch)
            end if
            return true
        end if
        ' atalhos do controle (valem tambem com o foco nos resultados)
        lk = LCase(key)
        if lk = "backspace" or lk = "rev" or lk = "red" then
            delChar()
            return true
        else if lk = "fwd" or lk = "green" then
            addChar(" ")
            return true
        else if lk = "replay" or lk = "yellow" then
            clearTerm()
            return true
        else if key <> "OK" and key <> "up" and key <> "down" and key <> "left" and key <> "right" and key <> "back" and key <> "options" then
            print "[DeltaTV] tecla nao mapeada na pesquisa: " + key
        end if
    end if

    if m.zone = "searchbar" then
        if key = "OK" then
            enterSearch()
        else if key = "down" then
            if m.count > 0 then
                focusGrid()
            else
                enterSearch()
            end if
        else if key = "back" then
            if m.searchMode then
                exitSearch()
            else if m.count > 0 then
                focusGrid()
            else
                focusCats()
            end if
        else if key = "left" then
            if m.searchMode then
                focusKbd()
            else
                focusCats()
            end if
        end if
        return true
    else if m.zone = "kbd" then
        if key = "back" then
            exitSearch()
        else if key = "OK" then
            pressKey()
        else if key = "left" then
            moveKey(0, -1)
        else if key = "right" then
            if not moveKey(0, 1) then
                if m.count > 0 then focusGrid() ' fim da linha: vai para os resultados
            end if
        else if key = "up" then
            if not moveKey(-1, 0) then focusSearchBar()
        else if key = "down" then
            moveKey(1, 0)
        end if
        return true ' o teclado consome todas as teclas
    else if m.zone = "grid" then
        if key = "left" or key = "back" then
            if m.searchMode then
                focusKbd() ' "left" so chega aqui na 1a coluna
            else
                focusCats()
            end if
            return true
        else if key = "up" then
            ' Sem wrap vertical, CIMA na primeira linha chega ate esta tela.
            if m.grid.itemFocused < m.grid.numColumns then
                focusSearchBar()
                return true
            end if
            return false
        else if key = "options" then
            toggleFavorite()
            return true
        end if
    else
        if key = "right" then
            openListItem(m.cats.itemFocused)
            return true
        else if key = "up" then
            return true
        else if key = "OK" and m.retryWhat <> "" then
            retry()
            return true
        end if
        ' "back" nas categorias nao e tratado aqui: a MainScene fecha a tela
    end if
    return false
end function

' ================================================================
' Pesquisa ao vivo: teclado embutido na lateral; CADA letra refaz a busca no catalogo inteiro (filmes ou series).
' Os dados ja estao na memoria (PreloadTask), entao a resposta e quase imediata. Uma pequena espera (0,2 s) junta
' toques rapidos; a grade so troca quando a resposta chega (sem piscar) e o foco continua no teclado.
' Limite de 300 resultados; titulos que COMECAM com o texto aparecem primeiro.
' ================================================================
sub updateSearchBar()
    t = Theme()
    m.searchRing.visible = (m.zone = "searchbar" or m.zone = "kbd")
    if m.searchMode then
        if m.searchTerm = "" then
            if m.isSeries then
                m.searchLabel.text = "Digite o nome da série"
            else
                m.searchLabel.text = "Digite o nome do filme"
            end if
            m.searchLabel.color = t.textMute
        else
            m.searchLabel.text = UCase(m.searchTerm) + "|"
            m.searchLabel.color = t.text
        end if
        m.searchIcon.blendColor = t.accentLight
    else
        if m.isSeries then
            m.searchLabel.text = "Pesquisar em todas as séries"
        else
            m.searchLabel.text = "Pesquisar em todos os filmes"
        end if
        screenName = "movies"
        if m.isSeries then screenName = "series"
        screenCopy = WLScreen(screenName)
        if screenCopy <> invalid then
            if ToText(screenCopy.searchLabel) <> "" then m.searchLabel.text = ToText(screenCopy.searchLabel)
        end if
        m.searchLabel.color = t.textMute
        m.searchIcon.blendColor = t.textMute
    end if
    if m.zone = "searchbar" then
        m.searchHint.text = "OK PESQUISAR"
    else if m.searchMode then
        m.searchHint.text = "↑ EDITAR BUSCA"
    else
        m.searchHint.text = "↑ BUSCAR"
    end if
    m.searchHint.color = t.accentLight
    m.searchHint.visible = (m.zone <> "kbd")
end sub

' liga/desliga o teclado na lateral (a lista de categorias fica escondida enquanto pesquisa)
sub setSearchMode(on as Boolean)
    m.searchMode = on
    m.cats.visible = not on
    m.catCount.visible = not on
    m.kbdBox.visible = on
    m.controlKeys.visible = on
    if on then
        m.header.text = "Pesquisar"
        m.hint.text = "→ Ver resultados   •   ↑ na primeira linha: editar busca   •   VOLTAR: categoria"
        updateSearchBar()
    else
        applyKind() ' restaura cabecalho, legenda e barra
    end if
end sub

sub enterSearch()
    if m.lazy and m.groups.count() = 0 then return
    if not m.lazy and m.legacyGroups.count() = 0 then return
    if m.searchMode then
        focusKbd()
        return
    end if
    m.searchFromGrid = (m.zone = "searchbar" or m.zone = "grid")
    if m.catIdx >= 0 then m.lastCatIdx = m.catIdx
    MarkSelected(m.cats.content, m.lastCatIdx)
    m.seq = m.seq + 1
    m.pendingFocusGrid = false
    m.busy = false
    m.retryWhat = ""
    m.nextCursor = invalid
    setSearchMode(true)
    focusKbd()
    onTermChanged()
    warmSearch()
end sub

' VOLTAR no teclado: sai da pesquisa e reabre a categoria que estava aberta
sub exitSearch()
    m.searchTimer.control = "stop"
    m.seq = m.seq + 1 ' descarta busca em voo
    m.busy = false
    m.searching = false
    m.searchTerm = ""
    idx = m.lastCatIdx
    if idx < 0 then idx = 0
    setSearchMode(false)
    selectCategory(idx, m.searchFromGrid)
    if m.searchFromGrid then
        ' Enquanto carrega a categoria, o foco fica na barra; afterFirstPage restaura a grade.
        if m.pendingFocusGrid then
            m.zone = "searchbar"
            updateSearchBar()
            updateKeyCursor()
            m.searchFocus.setFocus(true)
        end if
    else
        focusCats()
    end if
end sub

sub clearTerm()
    if m.searchTerm = "" then return
    m.searchTerm = ""
    onTermChanged()
end sub

' ---------- teclado QWERTY fixo (teclas desenhadas aqui; cursor proprio linha/coluna) ----------
sub buildKeyboard()
    t = Theme()
    m.kRows = [
        ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
        ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
        ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
        ["Z", "X", "C", "V", "B", "N", "M"],
        ["Espaço", "Apagar", "Limpar"],
        ["Ver resultados"]
    ]
    rowX = [0, 0, 15, 45, 0, 0]
    rowY = [0, 50, 100, 150, 214, 270]
    m.kNodes = []
    m.kCenter = []
    m.kr = 1
    m.kc = 0
    for r = 0 to m.kRows.count() - 1
        nodes = []
        centers = []
        row = m.kRows[r]
        for c = 0 to row.count() - 1
            if r < 4 then
                x = rowX[r] + c * 30
                w = 28
            else
                x = c * 100
                w = 96
                if r = 5 then w = 296
            end if
            pill = CreateObject("roSGNode", "Poster")
            pill.uri = "pkg:/images/round.9.png"
            pill.width = w
            pill.height = 44
            pill.translation = [x, rowY[r]]
            pill.blendColor = t.card
            lbl = CreateObject("roSGNode", "Label")
            size = 18
            if r >= 4 then size = 14
            Txt(lbl, size, false, t.textDim)
            lbl.width = w
            lbl.height = 44
            lbl.horizAlign = "center"
            lbl.vertAlign = "center"
            lbl.translation = [x, rowY[r]]
            lbl.text = row[c]
            m.kbdBox.appendChild(pill)
            m.kbdBox.appendChild(lbl)
            nodes.push({ pill: pill, lbl: lbl })
            centers.push(x + w / 2)
        end for
        m.kNodes.push(nodes)
        m.kCenter.push(centers)
    end for
    m.kShown = invalid
end sub

' Legenda visual dos botoes coloridos do controle Roku.
sub buildControlKeys()
    t = Theme()
    title = CreateObject("roSGNode", "Label")
    Txt(title, 16, true, t.text)
    title.text = "Teclas do controle"
    title.width = 286
    title.height = 24
    title.translation = [0, 0]
    m.controlKeys.appendChild(title)

    colors = ["0xE64B4BFF", "0x2EAD68FF", "0xE5B83EFF", "0x477EDBFF"]
    names = ["Apagar", "Espaço", "Limpar", "—"]
    xs = [5, 76, 147, 218]
    for i = 0 to 3
        key = CreateObject("roSGNode", "Poster")
        key.uri = "pkg:/images/round.9.png"
        key.width = 48
        key.height = 42
        key.translation = [xs[i], 31]
        key.blendColor = colors[i]
        m.controlKeys.appendChild(key)

        label = CreateObject("roSGNode", "Label")
        Txt(label, 12, false, t.textDim)
        label.text = names[i]
        label.width = 66
        label.height = 22
        label.horizAlign = "center"
        label.vertAlign = "center"
        label.translation = [xs[i] - 9, 75]
        m.controlKeys.appendChild(label)
    end for
end sub

' destaca a tecla do cursor (so quando o foco esta no teclado)
sub updateKeyCursor()
    t = Theme()
    if m.kShown <> invalid then
        o = m.kNodes[m.kShown.r][m.kShown.c]
        o.pill.blendColor = t.card
        Txt(o.lbl, 18, false, t.textDim)
        if m.kShown.r >= 4 then Txt(o.lbl, 14, false, t.textDim)
        m.kShown = invalid
    end if
    if m.zone = "kbd" then
        n = m.kNodes[m.kr][m.kc]
        n.pill.blendColor = t.accent
        size = 18
        if m.kr >= 4 then size = 14
        Txt(n.lbl, size, true, t.text)
        m.kShown = { r: m.kr, c: m.kc }
    end if
end sub

' move o cursor; devolve false se nao deu (borda)
function moveKey(dr as Integer, dc as Integer) as Boolean
    r = m.kr
    c = m.kc
    if dc <> 0 then
        c = c + dc
        if c < 0 or c >= m.kRows[r].count() then return false
    else
        r = r + dr
        if r < 0 or r >= m.kRows.count() then return false
        ' coluna da nova linha mais proxima (pelo centro) da tecla atual
        cx = m.kCenter[m.kr][m.kc]
        best = 0
        bestD = 100000
        for i = 0 to m.kCenter[r].count() - 1
            d = Abs(m.kCenter[r][i] - cx)
            if d < bestD then
                bestD = d
                best = i
            end if
        end for
        c = best
    end if
    m.kr = r
    m.kc = c
    updateKeyCursor()
    return true
end function

sub pressKey()
    if m.kr < 4 then
        addChar(m.kRows[m.kr][m.kc])
    else if m.kr = 5 then
        if m.count > 0 then focusGrid()
    else if m.kc = 0 then
        addChar(" ")
    else if m.kc = 1 then
        delChar()
    else
        clearTerm()
    end if
end sub

sub addChar(ch as String)
    if Len(m.searchTerm) >= 40 then
        return
    end if
    if ch = " " and (m.searchTerm = "" or Right(m.searchTerm, 1) = " ") then return ' sem espacos repetidos
    m.searchTerm = m.searchTerm + ch
    onTermChanged()
end sub

sub delChar()
    if m.searchTerm = "" then
        return
    end if
    m.searchTerm = Left(m.searchTerm, Len(m.searchTerm) - 1)
    onTermChanged()
end sub

sub onTermChanged()
    updateSearchBar()
    ' Invalida imediatamente qualquer busca anterior, inclusive enquanto a Task trabalha.
    m.searchTimer.control = "stop"
    m.seq = m.seq + 1
    m.nextCursor = invalid
    m.pendingFocusGrid = false
    if m.zone = "grid" then focusKbd()
    if TrimText(m.searchTerm) = "" then
        m.seq = m.seq + 1
        m.busy = false
        m.searching = false
        m.catIdx = -1
        resetGrid()
        SetEmojiText(m.gridTitle, "", 24, true, "0xFFFFFFFF", 780, 34)
        m.gridCount.text = ""
        if m.isSeries then
            setState("Digite para pesquisar em todas as séries", true)
        else
            setState("Digite para pesquisar em todos os filmes", true)
        end if
        return
    end if

    ' Pesquisa imediata e assíncrona: não depende do evento fire do Timer.
    ' SearchTask mantém somente o pedido mais recente quando várias letras chegam rápido.
    m.searching = true
    m.memWait = 0
    m.searchTimer.duration = 0.18
    m.searchTimer.control = "start"
end sub

sub onSearchTimer()
    runSearch()
end sub

sub runSearch()
    term = TrimText(m.searchTerm)
    if term = "" or not m.searching or not m.searchMode then
        return
    end if
    m.seq = m.seq + 1 ' descarta qualquer resposta em voo
    m.busy = false
    m.retryWhat = ""
    m.searchQuery = term
    m.searchIdx = 0
    m.searchSeen = {}
    m.catIdx = -1
    SetEmojiText(m.gridTitle, "Resultados para " + Chr(34) + term + Chr(34), 24, true, "0xFFFFFFFF", 780, 34)
    if m.count = 0 then
        setState("Buscando...", true)
    else
        m.gridCount.text = "Buscando...  " + resultsText(m.count, false) ' a grade antiga fica ate a nova chegar
    end if

    if m.lazy then
        searchNext()
    else
        legacySearch(term)
    end if
end sub

function SearchLimit() as Integer
    return 120
end function

sub searchNext()
    ' uma requisicao por lista: a rota "search" sem groupId usa o catalogo completo
    ' m.count ainda pode conter os resultados da pesquisa anterior enquanto a nova
    ' pesquisa aguarda a primeira resposta. Nao aplicar o limite antigo com searchIdx=0.
    if m.searchIdx >= m.sources.count() or (m.searchIdx > 0 and m.count >= SearchLimit()) then
        searchDone()
        return
    end if
    kind = "movie"
    if m.isSeries then kind = "series"
    sid = ToText(m.sources[m.searchIdx].id)
    if sid = "" or sid = "me" then
        ' memoria local: Task permanente (indice ja carregado, busca incremental)
        ensureSearchTask()
        m.busy = true
        m.searchTask.request = { reqId: m.seq, kind: kind, term: m.searchQuery, limit: SearchLimit() }
    else
        callApi("search", "search", { sourceId: sid, kind: kind, groupId: "", term: m.searchQuery })
    end if
end sub

sub ensureSearchTask()
    if m.searchTask <> invalid then
        return
    end if
    m.searchTask = CreateObject("roSGNode", "SearchTask")
    m.searchTask.observeField("result", "onSearchTaskResult")
    m.searchTask.control = "RUN"
end sub

' aquece o indice ao abrir a pesquisa: a 1a letra ja encontra tudo pronto
sub warmSearch()
    if not m.lazy then return
    kind = "movie"
    if m.isSeries then kind = "series"
    ensureSearchTask()
    m.searchTask.request = { reqId: -1, kind: kind, term: "", limit: 1 }
end sub

sub onSearchTaskResult(event as Object)
    r = event.getData()
    if r = invalid then
        return
    end if
    if r.reqId <> m.seq then
        return
    end if
    m.busy = false
    if r.fallback = true then
        ' memoria ainda baixando: espera (tenta de novo a cada 0,5 s) em vez de baixar o catalogo inteiro outra vez
        if m.memWait = invalid then m.memWait = 0
        m.memWait = m.memWait + 1
        if m.memWait <= 300 then
            setState("Carregando o catálogo... a pesquisa começa assim que terminar.", true)
            m.searchTimer.duration = 0.5
            m.searchTimer.control = "start"
            return
        end if
        kind = "movie"
        if m.isSeries then kind = "series"
        callApi("search", "search", { sourceId: ToText(m.sources[m.searchIdx].id), kind: kind, groupId: "", term: m.searchQuery })
        return
    end if
    onSearchResult(r)
end sub

sub onSearchResult(r as Object)
    if not m.searching or not m.searchMode then return
    if r.reqId <> m.seq then return
    if r.clearAuth then
        m.searching = false
        setState("Sessão encerrada. Feche e abra o aplicativo.", true)
        return
    end if

    restoreResultsFocus = (m.zone = "grid" and m.top.visible and m.top.isInFocusChain())
    if m.searchIdx = 0 then resetGrid() ' 1a resposta da busca nova: troca os resultados antigos de uma vez
    if not r.ok then
        setState(r.message + "  Continue digitando para tentar de novo.", true)
        m.gridCount.text = ""
        m.busy = false
        if restoreResultsFocus then focusKbd()
        return
    end if

    if m.searchIdx < m.sources.count() then
        src = m.sources[m.searchIdx]
        ' categoria de cada resultado (nome para o texto do card)
        byId = {}
        for each g in m.groups
            if g.sourceId = src.id then byId[g.id] = g
        end for
        list = r.data.items
        if m.isSeries then list = r.data.series
        if type(list) = "roArray" then
            items = []
            for each raw in list
                if type(raw) = "roAssociativeArray" then
                    key = src.id + "|" + ToText(raw.sid)
                    if ToText(raw.sid) = "" then key = src.id + "|" + ToText(raw.id)
                    if not m.searchSeen.DoesExist(key) and m.count + items.count() < SearchLimit() then
                        m.searchSeen[key] = true
                        g = byId[ToText(raw.groupId)]
                        if g = invalid then g = { id: ToText(raw.groupId), name: "", sourceId: src.id }
                        items.push(lazyCatItem(raw, g))
                    end if
                end if
            end for
            appendItems(items)
        end if
    end if

    m.searchIdx = m.searchIdx + 1
    if m.count > 0 then
        setState("", false)
        if m.searchIdx = 1 then m.grid.jumpToItem = 0
    end if
    keepKbdFocus()
    if restoreResultsFocus then
        if m.count > 0 then
            focusGrid()
        else
            focusKbd()
        end if
    end if
    updateSearchProgress()
    searchNext()
end sub

sub updateSearchProgress()
    m.gridCount.text = resultsText(m.count, (m.count >= SearchLimit()))
end sub

sub searchDone()
    m.busy = false
    updateSearchProgress()
    if m.count = 0 then
        setState("Nenhum resultado para " + Chr(34) + m.searchQuery + Chr(34) + ".", true)
    end if
end sub

function resultsText(n as Integer, more as Boolean) as String
    word = " resultados"
    if n = 1 then word = " resultado"
    s = n.toStr()
    if more then s = s + "+"
    return s + word
end function

' modo legado: o catalogo completo ja esta em memoria
sub legacySearch(term as String)
    termL = LCase(term)
    seen = {}
    items = []
    for each g in m.legacyGroups
        for each it in g.items
            if Instr(1, LCase(it.title), termL) > 0 and not seen.DoesExist(it.id) then
                seen[it.id] = true
                items.push(it)
                if items.count() >= SearchLimit() then exit for
            end if
        end for
        if items.count() >= SearchLimit() then exit for
    end for
    resetGrid()
    appendItems(items)
    m.gridCount.text = resultsText(m.count, (m.count >= SearchLimit()))
    if m.count = 0 then
        setState("Nenhum resultado para " + Chr(34) + term + Chr(34) + ".", true)
    else
        setState("", false)
        m.grid.jumpToItem = 0
    end if
end sub

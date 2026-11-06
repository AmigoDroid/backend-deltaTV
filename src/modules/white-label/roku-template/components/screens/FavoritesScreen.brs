sub init()
    t = Theme()
    m.grid = m.top.findNode("grid")
    m.count = m.top.findNode("count")
    m.emptyBox = m.top.findNode("emptyBox")
    Txt(m.top.findNode("header"), 26, true, t.text)
    Txt(m.count, 15, false, t.textDim)
    Txt(m.top.findNode("emptyTitle"), 24, true, t.text)
    Txt(m.top.findNode("emptySub"), 16, false, t.textDim)
    m.grid.observeField("itemSelected", "onSelected")
    m.nodes = []

    ' modo paginado: cada favorito (um por vez) e buscado por id; so carrega com a tela visivel
    m.lazyCat = invalid
    m.dirty = false
    m.seq = 0
    m.queue = []
    m.byId = {}
    m.cur = invalid
    m.playToken = ""
    m.failed = 0
    m.top.observeField("visible", "onShown")
end sub

sub onShown()
    if m.top.visible and m.dirty and m.lazyCat <> invalid then lazyLoad()
end sub

sub refreshList()
    cat = m.top.catalog
    if cat = invalid then return
    if cat.lazy = true then
        m.lazyCat = cat
        m.dirty = true
        if m.top.visible then lazyLoad()
        return
    end if
    m.lazyCat = invalid

    favs = FavSet()
    items = []
    for each key in ["channels", "movies", "series"]
        for each it in cat[key]
            if favs[it.id] = true then items.push(it)
        end for
    end for

    m.grid.content = BuildFlatContent(items, favs)
    m.emptyBox.visible = (items.count() = 0)
    m.grid.visible = (items.count() > 0)
    if items.count() = 1 then
        m.count.text = "1 item"
    else
        m.count.text = items.count().toStr() + " itens"
    end if
end sub

sub onSelected(event as Object)
    node = m.grid.content.getChild(event.getData())
    if node = invalid then return
    if m.lazyCat <> invalid or m.byId.count() > 0 then
        m.top.openItem = { id: node.itemId, kind: node.kind, item: m.byId[node.itemId] }
    else
        m.top.openItem = { id: node.itemId, kind: node.kind }
    end if
end sub

' ================================================================
' Modo paginado: favoritos de canais e filmes. Busca um item por vez (GET /catalog/items/:id)
' e monta a grade aos poucos; nada de catalogo completo em memoria.
' Inclui series: resolve metadados por get_series_info.
' ================================================================
sub lazyLoad()
    m.dirty = false
    cat = m.lazyCat
    if cat = invalid then return
    m.playToken = ToText(cat.playToken)
    m.byId = {}
    m.queue = []
    m.failed = 0
    for each fid in FavList()
        parsed = LazyParseFavId(ToText(fid))
        if parsed <> invalid then
            m.queue.push(parsed)
        else
            m.failed = m.failed + 1
        end if
    end for
    m.seq = m.seq + 1 ' invalida qualquer busca em andamento
    m.grid.content = BuildFlatContent([], FavSet())
    if m.queue.count() = 0 then
        m.emptyBox.visible = true
        m.grid.visible = false
        lazyFavDone()
        return
    end if
    m.emptyBox.visible = false
    m.grid.visible = false
    m.count.text = "Carregando favoritos..."
    lazyNextFav()
end sub

sub lazyNextFav()
    if m.queue.count() = 0 then
        lazyFavDone()
        return
    end if
    m.cur = m.queue.shift()
    m.seq = m.seq + 1
    t = CreateObject("roSGNode", "CatalogApiTask")
    t.observeField("result", "onFavResult")
    t.request = { reqId: m.seq, op: "item", path: "items/" + m.cur.itemId, query: { sourceId: m.cur.sourceId } }
    m.task = t
    t.control = "RUN"
end sub

sub onFavResult(event as Object)
    r = event.getData()
    if r = invalid then return
    if r.reqId <> m.seq then return ' busca antiga: ignora
    added = false
    if r.ok and r.data <> invalid then
        raw = r.data.item
        if raw <> invalid and type(raw) = "roAssociativeArray" then
            k = ToText(raw.kind)
            if k = "live" or k = "movie" or k = "series" then
                it = lazyFavItem(raw, k)
                m.byId[it.id] = it
                m.grid.content.appendChild(BuildItemNode(it, FavSet()))
                m.grid.visible = true
                added = true
                if m.top.visible and m.top.hasFocus() then m.grid.setFocus(true)
            end if
        end if
    end if
    if not added then m.failed = m.failed + 1
    lazyNextFav()
end sub

sub lazyFavDone()
    n = m.grid.content.getChildCount()
    m.emptyBox.visible = (n = 0)
    m.grid.visible = (n > 0)
    if n = 1 then
        m.count.text = "1 item"
    else if n = 0 then
        m.count.text = ""
    else
        m.count.text = n.toStr() + " itens"
    end if
    if m.failed > 0 then m.count.text = m.count.text + "  •  " + m.failed.toStr() + " favorito(s) salvo(s) indisponível(is) nesta lista"
    if m.top.visible and m.top.hasFocus() and n > 0 then m.grid.setFocus(true)
end sub

function lazyFavItem(raw as Object, k as String) as Object
    xfer = invalid
    path = GatewayPath(ToText(raw.srcVideo))
    it = {
        id: m.cur.sourceId + "-" + ToText(raw.id),
        kind: "movie",
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
        number: "",
        category: "",
        nowTitle: "",
        nextTitle: "",
        featured: false,
        seasons: [],
        sourceId: m.cur.sourceId,
        seriesId: "",
        lazySeries: false
    }
    if k = "live" then it.kind = "channel"
    if k = "series" then
        it.kind = "series"
        it.seriesId = ToText(raw.id)
        it.lazySeries = true
        it.url = ""
        it.playPath = ""
    end if
    return it
end function

sub focusContent()
    if m.grid.visible then
        m.grid.setFocus(true)
    else
        m.top.setFocus(true)
    end if
end sub

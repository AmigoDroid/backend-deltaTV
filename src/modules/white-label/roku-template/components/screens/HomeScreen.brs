sub init()
    t = Theme()
    m.hero = m.top.findNode("hero")
    m.kicker = m.top.findNode("kicker")
    m.title = m.top.findNode("title")
    m.subtitle = m.top.findNode("subtitle")
    m.dotsGroup = m.top.findNode("dots")

    Txt(m.kicker, 20, true, t.accentLight)
    Txt(m.title, 46, true, t.text)
    Txt(m.subtitle, 22, false, t.textDim)
    Txt(m.top.findNode("featTitle"), 22, true, t.text)
    Txt(m.top.findNode("featMore"), 15, false, t.textDim)
    for i = 0 to 2
        Txt(m.top.findNode("ct" + i.toStr()), 22, true, t.text)
        Txt(m.top.findNode("cs" + i.toStr()), 15, false, "0xD5D8E8FF")
    end for

    m.slides = [
        { img: "banner-delta.jpg", kicker: "DELTA TV", title: "Bem-vindo ao Delta TV", subText: "Seu entretenimento em um só lugar." },
        { img: "tv-ao-vivo.jpg", kicker: "AO VIVO", title: "TV ao vivo", subText: "Seus canais favoritos, a qualquer hora." },
        { img: "filmes.jpg", kicker: "FILMES", title: "Cinema na sua sala", subText: "Explore o catálogo completo." },
        { img: "series.jpg", kicker: "SÉRIES", title: "Maratone suas séries", subText: "Continue de onde parou." }
    ]
    m.slide = 0
    m.wlHero = ""
    m.dots = []
    for i = 0 to 3
        d = CreateObject("roSGNode", "Poster")
        d.uri = "pkg:/images/round.9.png"
        m.dotsGroup.appendChild(d)
        m.dots.push(d)
    end for

    ' O RowList nativo consome UP e movimenta foco internamente.
    ' Na Home, os cartoes e os destaques usam o MESMO dono do foco: m.top.
    ' Mantemos as imagens/estilo PosterItem mas controlamos a faixa aqui.
    m.row = CreateObject("roSGNode", "Group")
    m.row.translation = [0, 522]
    m.row.visible = false
    m.top.appendChild(m.row)
    m.featuredItems = []
    m.featureNodes = []
    m.featureNodeIndexes = []
    m.featureIndex = 0
    m.featureStart = 0
    m.featureSlots = 6
    for i = 0 to m.featureSlots - 1
        poster = CreateObject("roSGNode", "PosterItem")
        poster.translation = [36 + i * 166, 0]
        poster.width = 150
        poster.height = 173
        poster.visible = false
        m.row.appendChild(poster)
        m.featureNodes.push(poster)
        m.featureNodeIndexes.push(-1)
    end for

    m.zone = 0      ' 0 = cartoes, 1 = destaques (foco sempre em HomeScreen)
    m.card = 0
    m.hasContentFocus = false

    ' modo paginado: "Em destaque" = primeira pagina da primeira categoria de filmes (12 itens)
    m.seq = 0
    m.lz = invalid
    m.itemById = {}
    m.featDone = false
    m.featBusy = false

    m.timer = m.top.findNode("heroTimer")
    m.timer.observeField("fire", "nextSlide")
    m.timer.control = "start"
    m.top.observeField("visible", "onVisible")

    showSlide(0)
    onAppearance()
    updateCards()
end sub


' Three actual home arrangements, not just color skins.
sub onAppearance()
    if m.hero = invalid then return
    config = WLAppearance()
    template = "classic"
    if config <> invalid then
        if config.template = "cinema" or config.template = "compact" then template = config.template
        if ToText(config.brandName) <> "" then m.slides[0].kicker = ToText(config.brandName)
        if ToText(config.heroTitle) <> "" then m.slides[0].title = ToText(config.heroTitle)
        if ToText(config.tagline) <> "" then m.slides[0].subText = ToText(config.tagline)
    end if
    m.wlHero = ""
    if config <> invalid then m.wlHero = WLImageUri(config.heroUrl)
    t = Theme()
    Txt(m.kicker, 20, true, t.accentLight)
    Txt(m.title, 46, true, t.text)
    Txt(m.subtitle, 22, false, t.textDim)
    Txt(m.top.findNode("featTitle"), 22, true, t.text)
    Txt(m.top.findNode("featMore"), 15, false, t.textDim)
    for i = 0 to 2
        Txt(m.top.findNode("ct" + i.toStr()), 22, true, t.text)
        Txt(m.top.findNode("cs" + i.toStr()), 15, false, t.text)
        m.top.findNode("ring" + i.toStr()).blendColor = t.accent
        m.top.findNode("ico" + i.toStr()).blendColor = t.accent
    end for
    bgLeft = m.top.findNode("heroGradientLeft")
    bgBottom = m.top.findNode("heroGradientBottom")
    m.hideFeatured = (template = "cinema")
    ' Never show the DeltaTV promotional poster for a different app if no custom banner is supplied.
    m.hero.visible = (template <> "compact" and (config = invalid or m.wlHero <> ""))
    bgLeft.visible = (template <> "compact")
    bgBottom.visible = (template <> "compact")
    m.kicker.visible = m.hero.visible
    m.title.visible = m.hero.visible
    m.subtitle.visible = m.hero.visible
    m.dotsGroup.visible = m.hero.visible
    if template = "cinema" then
        m.hero.height = 420
        bgLeft.height = 420
        bgBottom.translation = [0, 290]
        m.kicker.translation = [38, 170]
        m.title.translation = [38, 208]
        m.subtitle.translation = [38, 285]
        m.dotsGroup.translation = [38, 370]
        cardsY = 452
    else if template = "compact" then
        m.hero.height = 314
        bgLeft.height = 314
        bgBottom.translation = [0, 184]
        cardsY = 62
    else
        m.hero.height = 314
        bgLeft.height = 314
        bgBottom.translation = [0, 184]
        m.kicker.translation = [38, 98]
        m.title.translation = [38, 124]
        m.subtitle.translation = [38, 194]
        m.dotsGroup.translation = [38, 274]
        cardsY = 322
    end if
    for i = 0 to 2
        x = 36 + i * 324
        m.top.findNode("card" + i.toStr()).translation = [x, cardsY]
        m.top.findNode("ico" + i.toStr()).translation = [x + 22, cardsY + 18]
        m.top.findNode("ct" + i.toStr()).translation = [x + 22, cardsY + 66]
        m.top.findNode("cs" + i.toStr()).translation = [x + 22, cardsY + 98]
        m.top.findNode("ring" + i.toStr()).translation = [x, cardsY]
    end for
    if template = "compact" then
        m.top.findNode("featTitle").translation = [36, 250]
        m.top.findNode("featMore").translation = [800, 252]
        m.top.findNode("featChev").translation = [958, 257]
        m.row.translation = [0, 290]
    else
        m.top.findNode("featTitle").translation = [36, 486]
        m.top.findNode("featMore").translation = [800, 488]
        m.top.findNode("featChev").translation = [958, 493]
        m.row.translation = [0, 522]
    end if
    if m.hideFeatured and m.zone = 1 then m.zone = 0
    if template = "compact" or m.wlHero <> "" then
        m.timer.control = "stop"
    else if m.top.visible then
        m.timer.control = "start"
    end if
    if m.wlHero <> "" then
        showSlide(0)
    else
        showSlide(m.slide)
    end if
    renderFeatured()
    updateCards()
end sub

sub onVisible()
    if m.top.visible then
        conf = WLAppearance()
        if conf = invalid then
            m.timer.control = "start"
        else if not DeltaWhiteLabelMode() and conf.template <> "compact" and WLImageUri(conf.heroUrl) = "" then
            m.timer.control = "start"
        end if
        ' a linha de destaque e opcional: se falhou (ex.: catalogo ainda sendo preparado), tenta de novo ao voltar
        if m.lz <> invalid and not m.featDone and not m.featBusy then featStart()
    else
        m.timer.control = "stop"
    end if
end sub

' ---------- hero ----------
sub nextSlide()
    showSlide((m.slide + 1) mod m.slides.count())
end sub

sub showSlide(i as Integer)
    m.slide = i
    s = m.slides[i]
    heroUri = "pkg:/images/" + s.img
    if i = 0 and m.wlHero <> "" then heroUri = m.wlHero
    m.hero.uri = heroUri
    m.kicker.text = s.kicker
    m.title.text = s.title
    m.subtitle.text = s.subText

    t = Theme()
    x = 0
    for k = 0 to m.dots.count() - 1
        d = m.dots[k]
        if k = i then
            d.width = 26 : d.height = 8
            d.blendColor = t.accent
        else
            d.width = 8 : d.height = 8
            d.blendColor = "0x5A5F7AFF"
        end if
        d.translation = [x, 0]
        x = x + d.width + 8
    end for
end sub

' ---------- catalogo ----------
sub onCatalog()
    cat = m.top.catalog
    if cat = invalid then return
    if cat.lazy = true then
        m.lz = { playToken: ToText(cat.playToken), sources: cat.sources, idx: 0 }
        m.itemById = {}
        m.featDone = false
        setFeaturedItems([])
        featStart()
        return
    end if
    m.lz = invalid
    m.featDone = true
    setFeaturedItems(cat.featured)
end sub

' A Home nunca transfere o foco real para o carrossel: o pai deve
' receber UP/DOWN/LEFT/RIGHT e os tratar de maneira deterministica.
sub setFeaturedItems(items as Dynamic)
    if type(items) <> "roArray" then items = []
    m.featuredItems = items
    m.featureIndex = 0
    m.featureStart = 0
    for i = 0 to m.featureSlots - 1
        m.featureNodeIndexes[i] = -1
    end for
    if items.count() = 0 and m.zone = 1 then
        m.zone = 0
        if m.top.visible and m.top.isInFocusChain() then m.top.setFocus(true)
    end if
    renderFeatured()
    updateCards()
end sub

sub renderFeatured()
    count = m.featuredItems.count()
    hasItems = (count > 0 and m.hideFeatured <> true)
    m.top.findNode("featTitle").visible = hasItems
    m.top.findNode("featMore").visible = hasItems
    m.top.findNode("featChev").visible = hasItems
    m.row.visible = hasItems
    if not hasItems then
        for each poster in m.featureNodes
            poster.visible = false
        end for
        return
    end if

    if m.featureIndex >= count then m.featureIndex = count - 1
    if m.featureIndex < 0 then m.featureIndex = 0
    if m.featureIndex < m.featureStart then m.featureStart = m.featureIndex
    if m.featureIndex >= m.featureStart + m.featureSlots then
        m.featureStart = m.featureIndex - m.featureSlots + 1
    end if
    for i = 0 to m.featureSlots - 1
        idx = m.featureStart + i
        poster = m.featureNodes[i]
        if idx < count then
            if m.featureNodeIndexes[i] <> idx then
                poster.itemContent = BuildItemNode(m.featuredItems[idx], invalid)
                m.featureNodeIndexes[i] = idx
            end if
            poster.visible = true
            poster.rowListHasFocus = (m.zone = 1 and m.hasContentFocus)
            poster.itemHasFocus = (m.zone = 1 and m.hasContentFocus and idx = m.featureIndex)
        else
            poster.visible = false
            m.featureNodeIndexes[i] = -1
        end if
    end for
end sub

sub activateFeaturedItem()
    if m.featureIndex < 0 or m.featureIndex >= m.featuredItems.count() then return
    item = m.featuredItems[m.featureIndex]
    if m.lz <> invalid then
        ' No catalogo paginado, MainScene nao possui o indice deste item.
        m.top.openItem = { id: item.id, kind: item.kind, item: item }
    else
        m.top.openItem = { id: item.id, kind: item.kind }
    end if
end sub

' ---------- destaque no modo paginado ----------
sub featStart()
    if m.lz = invalid then return
    if m.lz.sources.count() = 0 then return
    m.lz.idx = 0
    featRequestGroups()
end sub

sub featRequestGroups()
    if m.lz.idx >= m.lz.sources.count() then
        m.featBusy = false
        return ' nenhuma lista tem filmes: a Home segue sem a linha de destaque
    end if
    featCall("groups", "groups", { sourceId: m.lz.sources[m.lz.idx].id, kind: "movie" })
end sub

sub featCall(op as String, path as String, query as Object)
    m.seq = m.seq + 1
    t = CreateObject("roSGNode", "CatalogApiTask")
    t.observeField("result", "onFeatResult")
    t.request = { reqId: m.seq, op: op, path: path, query: query }
    m.task = t
    m.featBusy = true
    t.control = "RUN"
end sub

sub onFeatResult(event as Object)
    r = event.getData()
    if r = invalid then return
    if r.reqId <> m.seq then return ' resposta antiga
    if m.lz = invalid then return
    if not r.ok then
        m.featBusy = false ' opcional: sem erro na tela; tenta de novo quando a Home voltar a ficar visivel
        return
    end if
    src = m.lz.sources[m.lz.idx]
    if r.op = "groups" then
        groups = r.data.groups
        hasGroups = false
        if type(groups) = "roArray" then
            if groups.count() > 0 then hasGroups = true
        end if
        if not hasGroups then
            m.lz.idx = m.lz.idx + 1
            featRequestGroups()
            return
        end if
        m.lz.groupList = groups
        m.lz.gi = 0
        g = groups[0]
        m.lz.group = { id: ToText(g.id), name: ToText(g.name), sourceId: src.id }
        featCall("page", "items", { sourceId: src.id, kind: "movie", groupId: m.lz.group.id, pageSize: "12" })
    else if r.op = "page" then
        m.featBusy = false
        if type(r.data.items) <> "roArray" then return
        xfer = invalid
        items = []
        for each raw in r.data.items
            if type(raw) = "roAssociativeArray" then
                it = featItem(raw, m.lz.group, xfer)
                m.itemById[it.id] = it
                items.push(it)
            end if
        end for
        if items.count() = 0 then
            ' categoria vazia: tenta a proxima (ate 5)
            nextI = m.lz.gi + 1
            if nextI < m.lz.groupList.count() and nextI < 5 then
                m.lz.gi = nextI
                g = m.lz.groupList[nextI]
                m.lz.group = { id: ToText(g.id), name: ToText(g.name), sourceId: src.id }
                featCall("page", "items", { sourceId: src.id, kind: "movie", groupId: m.lz.group.id, pageSize: "12" })
            end if
            return
        end if
        m.featDone = true
        setFeaturedItems(items)
    end if
end sub

function featItem(raw as Object, g as Object, xfer as Dynamic) as Object
    path = GatewayPath(ToText(raw.srcVideo))
    return {
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
        url: GatewayUrl(path, m.lz.playToken, xfer),
        playPath: path,
        playToken: m.lz.playToken,
        streamFormat: GuessStreamFormat(path),
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
end function

' ---------- foco ----------
sub focusContent()
    if m.zone = 1 and (m.featuredItems.count() = 0 or m.hideFeatured = true) then m.zone = 0
    m.hasContentFocus = true
    m.top.setFocus(true)
    updateCards()
end sub

sub blurContent()
    m.hasContentFocus = false
    updateCards()
end sub

sub updateCards()
    for i = 0 to 2
        m.top.findNode("ring" + i.toStr()).visible = (m.zone = 0 and m.hasContentFocus and i = m.card)
    end for
    renderFeatured()
end sub

' Calcula a categoria visualmente acima do poster selecionado.
' Cada card ocupa aproximadamente dois slots da faixa.
sub selectCardAboveFeature()
    slot = m.featureIndex - m.featureStart
    if slot < 2 then
        m.card = 0
    else if slot < 4 then
        m.card = 1
    else
        m.card = 2
    end if
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false

    if m.zone = 0 then
        if key = "left" then
            if m.card > 0 then
                m.card = m.card - 1
                updateCards()
                print "[HomeFocus] card="; m.card
                return true
            end if
            return false ' na borda esquerda, MainScene abre o menu lateral
        else if key = "right" then
            if m.card < 2 then m.card = m.card + 1
            updateCards()
            print "[HomeFocus] card="; m.card
            return true
        else if key = "down" then
            if m.featuredItems.count() > 0 and m.hideFeatured <> true then
                m.zone = 1
                ' Abre na area alinhada ao card ativo quando necessario.
                slot = m.featureIndex - m.featureStart
                if (m.card = 0 and slot >= 2) or (m.card = 1 and (slot < 2 or slot >= 4)) or (m.card = 2 and slot < 4) then
                    nextIndex = m.featureStart + m.card * 2
                    if nextIndex >= m.featuredItems.count() then nextIndex = m.featuredItems.count() - 1
                    m.featureIndex = nextIndex
                end if
                updateCards()
                print "[HomeFocus] cards -> destaque index="; m.featureIndex
            end if
            return true
        else if key = "up" then
            return true
        else if key = "OK" then
            m.top.navigateTo = m.card + 1   ' 1=TV, 2=Filmes, 3=Series
            return true
        end if
    else
        if key = "up" then
            selectCardAboveFeature()
            m.zone = 0
            updateCards()
            print "[HomeFocus] destaque -> card="; m.card
            return true
        else if key = "left" then
            if m.featureIndex > 0 then
                m.featureIndex = m.featureIndex - 1
                updateCards()
                print "[HomeFocus] destaque index="; m.featureIndex
                return true
            end if
            return false ' so sai para o menu se estiver no PRIMEIRO destaque
        else if key = "right" then
            if m.featureIndex < m.featuredItems.count() - 1 then
                m.featureIndex = m.featureIndex + 1
                updateCards()
                print "[HomeFocus] destaque index="; m.featureIndex
            end if
            return true
        else if key = "OK" then
            activateFeaturedItem()
            return true
        else if key = "down" then
            return true
        end if
    end if
    return false
end function

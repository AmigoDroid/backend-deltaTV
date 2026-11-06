sub init()
    t = Theme()
    m.backdrop = m.top.findNode("backdrop")
    m.pBg = m.top.findNode("pBg")
    m.pArt = m.top.findNode("pArt")
    m.seasonLabel = m.top.findNode("seasonLabel")
    m.seasonHint = m.top.findNode("seasonHint")
    m.seasonTabs = m.top.findNode("seasonTabs")
    m.episodeHeader = m.top.findNode("episodeHeader")
    m.episodePageHint = m.top.findNode("episodePageHint")
    m.episodeRows = m.top.findNode("episodeRows")
    m.episodeScrollTrack = m.top.findNode("episodeScrollTrack")
    m.episodeScrollThumb = m.top.findNode("episodeScrollThumb")
    m.seriesStatus = m.top.findNode("seriesStatus")

    Txt(m.top.findNode("kind"), 14, true, t.accentLight)
    Txt(m.top.findNode("meta"), 17, false, t.accentLight)
    Txt(m.top.findNode("desc"), 17, false, t.textDim)
    Txt(m.top.findNode("tmdbCredit"), 12, false, t.accentLight)
    Txt(m.top.findNode("b0label"), 19, true, t.text)
    Txt(m.top.findNode("b1label"), 19, true, t.text)
    Txt(m.seasonLabel, 20, true, t.text)
    Txt(m.seasonHint, 13, false, t.textMute)
    Txt(m.episodeHeader, 16, true, t.text)
    Txt(m.episodePageHint, 13, false, t.textMute)
    Txt(m.seriesStatus, 17, false, t.textDim)
    Txt(m.top.findNode("seriesResume"), 17, false, t.accentLight)
    for counter = 0 to 4
        labelNode = m.top.findNode("seasonTab" + counter.toStr() + "Label")
        Txt(labelNode, 17, true, t.text)
    end for
    for counter = 0 to 3
        prefix = "episodeRow" + counter.toStr()
        Txt(m.top.findNode(prefix + "Number"), 17, true, t.accentLight)
        Txt(m.top.findNode(prefix + "Title"), 18, true, t.text)
        Txt(m.top.findNode(prefix + "Desc"), 14, false, t.textDim)
        Txt(m.top.findNode(prefix + "Action"), 14, false, t.accentLight)
    end for

    m.zone = 0 ' 0 = Assistir/Favoritar, 1 = temporadas, 2 = episodios
    m.btn = 0
    m.season = 0
    m.isSeries = false
    m.item = invalid
    m.currentEps = []
    m.episodeIndex = 0
    m.episodeOffset = 0
    m.lazySeries = false
    m.dseq = 0
    m.lazySeasons = []
    m.lazyEps = []
    m.lazyNextCursor = ""
    m.lastRequestedCursor = ""
    m.advanceAfterLoad = false
    m.enterAfterLoad = false
    m.lazyBusy = false
    m.statusText = ""
    m.restoreState = invalid
    m.restorePending = false
    m.tmdbSeq = 0
    m.tmdbTask = invalid
    m.tmdbCache = {}
    m.tmdbCacheOrder = []
end sub

sub onItem()
    it = m.top.item
    if it = invalid then return
    m.dseq = m.dseq + 1 ' invalida respostas pendentes de outra serie
    m.tmdbSeq = m.tmdbSeq + 1
    if m.tmdbTask <> invalid then m.tmdbTask.control = "stop"
    m.tmdbTask = invalid
    m.top.findNode("tmdbCredit").visible = false
    m.item = it
    m.isSeries = (it.kind = "series")
    m.lazySeries = (it.lazySeries = true and m.isSeries)
    m.zone = 0
    m.btn = 0
    m.season = 0
    m.episodeIndex = 0
    m.episodeOffset = 0
    m.currentEps = []
    m.lazySeasons = []
    m.lazyEps = []
    m.lazyNextCursor = ""
    m.lastRequestedCursor = ""
    m.advanceAfterLoad = false
    m.enterAfterLoad = false
    m.lazyBusy = false
    m.statusText = ""

    m.restoreState = invalid
    m.restorePending = false
    if m.isSeries then
        m.restoreState = VodReadSeriesState(DetailSeriesRef())
        m.restorePending = (m.restoreState <> invalid)
    end if
    if m.isSeries then
        m.top.findNode("kind").text = "SÉRIE"
        m.backdrop.uri = "pkg:/images/series.jpg"
    else
        m.top.findNode("kind").text = "FILME"
        m.backdrop.uri = "pkg:/images/filmes.jpg"
    end if
    if it.backdrop <> "" then m.backdrop.uri = it.backdrop

    m.pBg.blendColor = it.accent
    m.pArt.uri = it.poster
    SetEmojiText(m.top.findNode("title"), it.title, 40, true, "0xFFFFFFFF", 900, 56)
    m.top.findNode("meta").text = MetaLine(it.yearText, it.genreText, it.durationText, it.ageRating)
    m.top.findNode("desc").text = EmojiStrip(it.description)

    m.seasonLabel.visible = m.isSeries
    m.seasonHint.visible = m.isSeries
    m.seasonTabs.visible = m.isSeries
    m.episodeHeader.visible = m.isSeries
    m.episodePageHint.visible = m.isSeries
    m.episodeRows.visible = m.isSeries
    m.episodeScrollTrack.visible = false
    m.episodeScrollThumb.visible = false
    m.seriesStatus.visible = false
    if m.isSeries then
        if m.lazySeries then
            lazySeriesInit()
        else
            loadSeason(SavedSeasonIndex())
            RestoreEpisodeSelection()
        end if
    end if
    drawScreen()
    loadTmdbDetails()
end sub

' Busca TMDB apenas ao abrir o detalhe, nunca ao paginar a grade.
sub loadTmdbDetails()
    if m.item = invalid then return
    if RegRead("tmdb_enabled") <> "true" then return
    if DeltaTmdbCredential() = "" then return
    title = ToText(m.item.title)
    if title = "" then return
    cacheKey = LCase(ToText(m.item.kind)) + ":" + LCase(title) + ":" + ToText(m.item.yearText)
    m.tmdbCacheKey = cacheKey
    if m.tmdbCache.DoesExist(cacheKey) then
        applyTmdbDetails(m.tmdbCache[cacheKey])
        return
    end if
    task = CreateObject("roSGNode", "TmdbTask")
    task.request = { operation: "details", reqId: m.tmdbSeq, itemId: ToText(m.item.id), kind: ToText(m.item.kind), title: title, year: ToText(m.item.yearText) }
    task.observeField("result", "onTmdbDetailsReady")
    m.tmdbTask = task
    task.control = "RUN"
end sub

sub onTmdbDetailsReady(event as Object)
    r = event.getData()
    if r = invalid then return
    if r.reqId <> m.tmdbSeq then return
    if m.item = invalid or r.itemId <> ToText(m.item.id) then return
    m.tmdbTask = invalid
    if r.ok <> true or r.details = invalid then
        print "[TMDB] Sem informacoes; permanecem os metadados originais."
        return
    end if
    ' Cache pequeno por sessao, sem acionar rede ao reabrir o mesmo titulo.
    if not m.tmdbCache.DoesExist(m.tmdbCacheKey) then
        if m.tmdbCacheOrder.count() >= 24 then
            evict = m.tmdbCacheOrder.shift()
            m.tmdbCache.Delete(evict)
        end if
        m.tmdbCache[m.tmdbCacheKey] = r.details
        m.tmdbCacheOrder.push(m.tmdbCacheKey)
    end if
    applyTmdbDetails(r.details)
end sub

sub applyTmdbDetails(data as Object)
    if data = invalid then return
    ' Nunca modifica URLs de reprodução ou o item do provedor.
    if ToText(data.poster) <> "" then m.pArt.uri = data.poster
    if ToText(data.backdrop) <> "" then m.backdrop.uri = data.backdrop
    desc = ToText(data.description)
    if desc <> "" then m.top.findNode("desc").text = EmojiStrip(desc)
    year = ToText(m.item.yearText)
    genre = ToText(m.item.genreText)
    duration = ToText(m.item.durationText)
    age = ToText(m.item.ageRating)
    if ToText(data.year) <> "" then year = data.year
    if ToText(data.genre) <> "" then genre = data.genre
    if ToText(data.duration) <> "" then duration = data.duration
    line = MetaLine(year, genre, duration, age)
    if ToText(data.rating) <> "" then
        if line <> "" then line = line + "   •   "
        line = line + "TMDB " + data.rating + "/10"
    end if
    m.top.findNode("meta").text = line
    m.top.findNode("tmdbCredit").visible = true
end sub

function seasonCount() as Integer
    if not m.isSeries or m.item = invalid then return 0
    if m.lazySeries then return m.lazySeasons.count()
    if type(m.item.seasons) <> "roArray" then return 0
    return m.item.seasons.count()
end function

function seasonNumber(index as Integer) as String
    if index < 0 or index >= seasonCount() then return ""
    if m.lazySeries then
        sn = ToText(m.lazySeasons[index].season)
    else
        sn = ToText(m.item.seasons[index].number)
    end if
    if sn = "" then sn = (index + 1).toStr()
    return sn
end function

sub showStatus(message as String)
    m.statusText = message
    drawEpisodes()
end sub

sub loadSeason(index as Integer)
    if m.lazySeries then
        m.restorePending = false
        lazyLoadSeason(index)
        return
    end if
    total = seasonCount()
    if total = 0 then
        m.currentEps = []
        showStatus("Nenhuma temporada disponível.")
        drawScreen()
        return
    end if
    if index < 0 then index = 0
    if index >= total then index = total - 1
    m.season = index
    m.currentEps = m.item.seasons[index].episodes
    if type(m.currentEps) <> "roArray" then m.currentEps = []
    m.episodeIndex = 0
    m.episodeOffset = 0
    m.enterAfterLoad = false
    m.lazyNextCursor = ""
    m.statusText = ""
    if m.currentEps.count() = 0 then m.statusText = "Esta temporada não tem episódios disponíveis."
    print "[SeriesFocus] temporada="; seasonNumber(index); " episodios="; m.currentEps.count()
    drawScreen()
end sub

' Atualiza o destaque visual sem entregar o foco a um MarkupList ou RowList.
sub drawScreen()
    updateButtons()
    drawSeasons()
    drawEpisodes()
end sub

sub updateButtons()
    t = Theme()
    m.top.findNode("seriesResume").visible = false
    m.top.findNode("b0label").text = "Assistir"
    if m.isSeries then
        saved = VodReadSeriesState(DetailSeriesRef())
        if saved <> invalid then
            caption = "Você parou: T" + ToText(saved.season) + " • E" + ToText(saved.number)
            if saved.completed = true then
                caption = caption + " (concluído)"
            else
                if m.currentEps.count() > 0 then
                    if ToText(m.currentEps[m.episodeIndex].id) = ToText(saved.episodeId) then m.top.findNode("b0label").text = "Continuar"
                end if
                minutes = Int(Val(ToText(saved.position)) / 60)
                if minutes > 0 then caption = caption + " • " + minutes.toStr() + " min"
            end if
            m.top.findNode("seriesResume").text = caption
            m.top.findNode("seriesResume").visible = true
        end if
    end if
    for counter = 0 to 1
        m.top.findNode("b" + counter.toStr() + "ring").visible = (m.zone = 0 and m.btn = counter)
    end for
    m.top.findNode("b0bg").blendColor = t.accent
    fav = false
    if m.item <> invalid then fav = FavIsFav(m.item.id)
    if fav then
        m.top.findNode("b1label").text = "Nos favoritos"
        m.top.findNode("b1ico").uri = "pkg:/images/ic_heart_filled.png"
        m.top.findNode("b1ico").blendColor = "0xFF6B9DFF"
        m.top.findNode("b1bg").blendColor = t.accentSoft
    else
        m.top.findNode("b1label").text = "Favoritar"
        m.top.findNode("b1ico").uri = "pkg:/images/ic_heart.png"
        m.top.findNode("b1ico").blendColor = t.text
        m.top.findNode("b1bg").blendColor = "0x23284AFF"
    end if
end sub

sub drawSeasons()
    if not m.isSeries then return
    t = Theme()
    total = seasonCount()
    if total = 0 then
        m.seasonLabel.text = "TEMPORADAS"
        m.seasonHint.text = ""
        for counter = 0 to 4
            m.top.findNode("seasonTab" + counter.toStr()).visible = false
        end for
        return
    end if
    m.seasonLabel.text = "TEMPORADAS  (" + total.toStr() + ")"
    startIndex = m.season - 2
    if startIndex < 0 then startIndex = 0
    if total > 5 and startIndex > total - 5 then startIndex = total - 5
    if total <= 5 then startIndex = 0
    for counter = 0 to 4
        tabIndex = startIndex + counter
        prefix = "seasonTab" + counter.toStr()
        seasonTabNode = m.top.findNode(prefix)
        seasonTabNode.visible = (tabIndex < total)
        if tabIndex < total then
            captionText = "Temporada " + seasonNumber(tabIndex)
            if counter = 0 and startIndex > 0 then captionText = "◀ " + captionText
            if counter = 4 and tabIndex < total - 1 then captionText = captionText + " ▶"
            m.top.findNode(prefix + "Label").text = captionText
            m.top.findNode(prefix + "Bg").blendColor = t.card
            if tabIndex = m.season then m.top.findNode(prefix + "Bg").blendColor = t.accentSoft
            m.top.findNode(prefix + "Ring").visible = (m.zone = 1 and tabIndex = m.season)
        end if
    end for
    m.seasonHint.text = "Temporada " + (m.season + 1).toStr() + " de " + total.toStr() + "   •   ◀ ▶ trocar   •   OK abrir episódios   •   ↑ botões"
end sub

sub drawEpisodes()
    if not m.isSeries then return
    t = Theme()
    countEps = m.currentEps.count()
    if countEps = 0 then
        m.episodeIndex = 0
        m.episodeOffset = 0
    else
        if m.episodeIndex >= countEps then m.episodeIndex = countEps - 1
        if m.episodeIndex < 0 then m.episodeIndex = 0
        if m.episodeOffset > m.episodeIndex then m.episodeOffset = m.episodeIndex
        if m.episodeIndex >= m.episodeOffset + 4 then m.episodeOffset = m.episodeIndex - 3
    end if
    m.episodeHeader.text = "EPISÓDIOS  (" + countEps.toStr() + ")"
    if countEps > 0 then
        hintText = "Episódio " + (m.episodeIndex + 1).toStr() + " de " + countEps.toStr()
        if m.lazyNextCursor <> "" then hintText = hintText + "+"
        hintText = hintText + "   •   ↑ ↓ rolar   •   OK assistir"
        if m.lazyBusy then hintText = "Carregando mais episódios...  •  ↑ ↓ rolar"
    else
        hintText = "Selecione a temporada e pressione OK"
    end if
    m.episodePageHint.text = hintText
    hasScroll = (countEps > 4)
    m.episodeScrollTrack.visible = hasScroll
    m.episodeScrollThumb.visible = hasScroll
    if hasScroll then
        scrollRange = countEps - 4
        scrollY = 493 + Int((m.episodeOffset * 162) / scrollRange)
        m.episodeScrollThumb.translation = [1225, scrollY]
    end if
    for counter = 0 to 3
        epIndex = m.episodeOffset + counter
        prefix = "episodeRow" + counter.toStr()
        rowNode = m.top.findNode(prefix)
        rowNode.visible = (epIndex < countEps)
        if epIndex < countEps then
            ep = m.currentEps[epIndex]
            epNum = ToText(ep.epNumber)
            if epNum = "" then epNum = (epIndex + 1).toStr()
            m.top.findNode(prefix + "Number").text = "EP " + epNum
            epTitle = ToText(ep.title)
            if epTitle = "" then epTitle = "Episódio " + epNum
            m.top.findNode(prefix + "Title").text = EmojiStrip(epTitle)
            epDesc = ToText(ep.description)
            if epDesc = "" then epDesc = "Temporada " + seasonNumber(m.season)
            dur = ToText(ep.durationText)
            if dur <> "" then epDesc = epDesc + "  •  " + dur
            m.top.findNode(prefix + "Desc").text = EmojiStrip(epDesc)
            isSelected = (m.zone = 2 and m.episodeIndex = epIndex)
            m.top.findNode(prefix + "Ring").visible = isSelected
            m.top.findNode(prefix + "Bg").blendColor = t.card
            if isSelected then m.top.findNode(prefix + "Bg").blendColor = t.accentSoft
            m.top.findNode(prefix + "Action").visible = isSelected
        end if
    end for
    m.seriesStatus.visible = (m.statusText <> "" and countEps = 0)
    m.seriesStatus.text = m.statusText
end sub

' A janela visual rola continuamente e os episódios são buscados sob demanda.
sub maybeLoadMoreEpisodes()
    if not m.lazySeries then return
    if m.lazyBusy or m.lazyNextCursor = "" then return
    if m.episodeIndex >= m.currentEps.count() - 5 then lazyRequestEpisodes(m.lazyNextCursor)
end sub

sub focusContent()
    m.top.setFocus(true)
    if m.isSeries then RefreshSeriesSelection()
    if m.zone = 2 and m.currentEps.count() = 0 then m.zone = 1
    if m.zone = 1 and seasonCount() = 0 then m.zone = 0
    drawScreen()
end sub

sub playMain()
    it = m.item
    if it = invalid then return
    if not m.isSeries then
        m.top.playItem = CopyTrickplayMetadata(it, {
            id: it.id,
            title: it.title,
            url: it.url,
            playPath: it.playPath,
            playToken: it.playToken,
            streamFormat: it.streamFormat,
            live: false
        })
        return
    end if
    if m.currentEps.count() > 0 then
        ' Assistir acompanha o episodio selecionado na lista continua.
        playEpisode(m.episodeIndex)
    else if not m.lazySeries and seasonCount() = 0 then
        if it.url <> "" then
            m.top.playItem = CopyTrickplayMetadata(it, {
                id: it.id,
                title: it.title,
                url: it.url,
                playPath: it.playPath,
                playToken: it.playToken,
                streamFormat: it.streamFormat,
                live: false
            })
        end if
    else
        showStatus("Escolha uma temporada com episódios para assistir.")
    end if
end sub

' Cada episodio tem chave propria: lista + serie + temporada + episodio.
' Nao reutilizar o ID da serie, senao todas as posicoes se misturam.
function EpisodeBookmarkId(ep as Object, epIndex as Integer) as String
    seriesKey = ToText(m.item.id)
    if seriesKey = "" then seriesKey = ToText(m.item.sourceId) + "-" + ToText(m.item.seriesId)
    episodeKey = ToText(ep.id)
    if episodeKey = "" then episodeKey = ToText(ep.epNumber)
    if episodeKey = "" then episodeKey = (epIndex + 1).toStr()
    return "ep-" + seriesKey + "-s" + seasonNumber(m.season) + "-e" + episodeKey
end function

sub playEpisode(epIndex as Integer)
    if epIndex < 0 or epIndex >= m.currentEps.count() then return
    ep = m.currentEps[epIndex]
    if ToText(ep.url) = "" and ToText(ep.playPath) = "" then
        showStatus("Este episódio não possui uma fonte de reprodução disponível.")
        return
    end if
    playItem = DetailEpisodeItem(ep, seasonNumber(m.season), epIndex)
    if epIndex + 1 < m.currentEps.count() then
        playItem.nextEpisode = DetailEpisodeItem(m.currentEps[epIndex + 1], seasonNumber(m.season), epIndex + 1)
    else if not m.lazySeries and m.season + 1 < seasonCount() then
        following = m.item.seasons[m.season + 1].episodes
        if type(following) = "roArray" then
            if following.count() > 0 then playItem.nextEpisode = DetailEpisodeItem(following[0], seasonNumber(m.season + 1), 0)
        end if
    end if
    m.top.playItem = playItem
end sub

function DetailEpisodeItem(ep as Object, sn as String, epIndex as Integer) as Object
    episodeKey = ToText(ep.id)
    if episodeKey = "" then episodeKey = ToText(ep.epNumber)
    if episodeKey = "" then episodeKey = (epIndex + 1).toStr()
    return CopyTrickplayMetadata(ep, {
        id: "ep-" + DetailSeriesRef() + "-s" + sn + "-e" + episodeKey,
        title: m.item.title + " - " + ToText(ep.title),
        url: ep.url,
        playPath: ep.playPath,
        playToken: ep.playToken,
        streamFormat: ep.streamFormat,
        live: false,
        seriesRef: DetailSeriesRef(),
        seriesId: ToText(m.item.seriesId),
        seriesEpisodeId: episodeKey,
        seriesSeason: sn,
        seriesEpisodeNumber: ToText(ep.epNumber)
    })
end function

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if key = "back" then
        m.top.closeRequest = true
        return true
    end if
    if key <> "up" and key <> "down" and key <> "left" and key <> "right" and key <> "OK" then return false
    if m.zone = 0 then
        if key = "left" then
            m.btn = 0
        else if key = "right" then
            m.btn = 1
        else if key = "down" then
            if m.isSeries and seasonCount() > 0 then m.zone = 1
        else if key = "OK" then
            if m.btn = 0 then
                playMain()
            else
                wasFav = FavIsFav(m.item.id)
                nowFav = FavToggle(m.item.id)
                if nowFav = wasFav then
                    showStatus("Não foi possível salvar o favorito. Tente novamente.")
                else
                    m.top.favoritesChanged = true
                end if
            end if
        end if
    else if m.zone = 1 then
        if key = "up" then
            m.zone = 0
        else if key = "left" then
            if m.season > 0 then loadSeason(m.season - 1)
        else if key = "right" then
            if m.season < seasonCount() - 1 then loadSeason(m.season + 1)
        else if key = "down" or key = "OK" then
            if m.currentEps.count() > 0 then
                m.zone = 2
            else if m.lazySeries then
                if m.lazyBusy then
                    if key = "OK" then m.enterAfterLoad = true
                else
                    m.enterAfterLoad = (key = "OK")
                    lazyLoadSeason(m.season)
                    if key = "OK" then m.enterAfterLoad = true
                end if
            end if
        end if
    else if m.zone = 2 then
        if key = "up" then
            if m.episodeIndex > 0 then
                m.episodeIndex = m.episodeIndex - 1
                if m.episodeIndex < m.episodeOffset then m.episodeOffset = m.episodeIndex
            else
                m.zone = 1
            end if
        else if key = "down" then
            nextIndex = m.episodeIndex + 1
            if nextIndex < m.currentEps.count() then
                m.episodeIndex = nextIndex
                if m.episodeIndex >= m.episodeOffset + 4 then m.episodeOffset = m.episodeIndex - 3
            else if m.lazySeries and (m.lazyNextCursor <> "" or m.lazyBusy) then
                m.advanceAfterLoad = true
            end if
            maybeLoadMoreEpisodes()
        else if key = "left" then
            m.zone = 1
        else if key = "OK" then
            playEpisode(m.episodeIndex)
        end if
    end if
    drawScreen()
    return true
end function

' Temporadas e episodios sob demanda: carregar blocos conforme o usuario rola a lista.
sub lazySeriesInit()
    m.currentEps = []
    m.lazySeasons = []
    m.statusText = "Carregando temporadas..."
    drawScreen()
    lazyApi("seasons", "series/" + m.item.seriesId + "/seasons", { sourceId: m.item.sourceId })
end sub

sub lazyApi(operation as String, path as String, query as Object)
    m.dseq = m.dseq + 1
    taskNode = CreateObject("roSGNode", "CatalogApiTask")
    taskNode.observeField("result", "onLazyResult")
    taskNode.request = { reqId: m.dseq, op: operation, path: path, query: query }
    m.dtask = taskNode
    m.lazyBusy = true
    taskNode.control = "RUN"
end sub

sub onLazyResult(event as Object)
    response = event.getData()
    if response = invalid then return
    if response.reqId <> m.dseq then return
    m.lazyBusy = false
    if response.op = "seasons" then
        lazyOnSeasons(response)
    else if response.op = "episodes" then
        lazyOnEpisodes(response)
    end if
end sub

sub lazyOnSeasons(response as Object)
    if not response.ok then
        showStatus(lazyErrorText(response))
        return
    end if
    if type(response.data.seasons) <> "roArray" then
        showStatus("Resposta de temporadas inválida.")
        return
    end if
    m.lazySeasons = response.data.seasons
    if seasonCount() = 0 then
        showStatus("Nenhuma temporada disponível para esta série.")
        drawSeasons()
        return
    end if
    lazyLoadSeason(SavedSeasonIndex())
end sub

function lazyErrorText(response as Object) as String
    if response.status = 503 and response.code = "CATALOG_PREPARING" then return "O catálogo ainda está sendo preparado. Tente novamente."
    if response.clearAuth then return "Sessão encerrada. Feche e abra o aplicativo."
    return "Não foi possível carregar os episódios. Pressione OK na temporada para tentar novamente."
end function

sub lazyLoadSeason(index as Integer)
    countSeasons = seasonCount()
    if countSeasons = 0 then return
    if index < 0 then index = 0
    if index >= countSeasons then index = countSeasons - 1
    m.season = index
    m.lazyEps = []
    m.currentEps = m.lazyEps
    m.lazyNextCursor = ""
    m.episodeIndex = 0
    m.episodeOffset = 0
    m.advanceAfterLoad = false
    m.enterAfterLoad = false
    m.statusText = "Carregando episódios da temporada " + seasonNumber(index) + "..."
    print "[SeriesFocus] carregando temporada="; seasonNumber(index)
    drawScreen()
    lazyRequestEpisodes("")
end sub

sub lazyRequestEpisodes(cursor as String)
    q = { sourceId: m.item.sourceId, pageSize: "100", cursor: cursor }
    sn = ToText(m.lazySeasons[m.season].season)
    if sn <> "" then q.season = sn
    m.lastRequestedCursor = cursor
    m.statusText = "Carregando episódios..."
    drawEpisodes()
    lazyApi("episodes", "series/" + m.item.seriesId + "/episodes", q)
end sub

sub lazyOnEpisodes(response as Object)
    if not response.ok then
        m.enterAfterLoad = false
        m.advanceAfterLoad = false
        showStatus(lazyErrorText(response))
        return
    end if
    if type(response.data.episodes) <> "roArray" then
        m.enterAfterLoad = false
        m.advanceAfterLoad = false
        showStatus("Resposta de episódios inválida.")
        return
    end if
    prevCount = m.lazyEps.count()
    xfer = invalid
    for each raw in response.data.episodes
        if type(raw) = "roAssociativeArray" then
            epTitle = ToText(raw.episodeTitle)
            if epTitle = "" then epTitle = ToText(raw.title)
            if epTitle = "" then epTitle = "Episódio " + (m.lazyEps.count() + 1).toStr()
            path = GatewayPath(ToText(raw.srcVideo))
            epData = {
                id: ToText(raw.id),
                title: epTitle,
                description: "",
                epNumber: ToText(raw.episode),
                durationText: "",
                url: GatewayUrl(path, m.item.playToken, xfer),
                playPath: path,
                playToken: m.item.playToken,
                streamFormat: GuessStreamFormat(path)
            }
            m.lazyEps.push(CopyTrickplayMetadata(raw, epData))
        end if
    end for
    m.currentEps = m.lazyEps
    nextCursorValue = ""
    if response.data.nextCursor <> invalid then nextCursorValue = ToText(response.data.nextCursor)
    ' Protecao contra backend que devolve a mesma pagina/cursor sem progresso.
    if m.lazyEps.count() = prevCount or nextCursorValue = m.lastRequestedCursor then nextCursorValue = ""
    m.lazyNextCursor = nextCursorValue
    m.statusText = ""
    if m.currentEps.count() = 0 then m.statusText = "Nenhum episódio disponível nesta temporada."
    if m.enterAfterLoad then
        if m.currentEps.count() > 0 then m.zone = 2
        m.enterAfterLoad = false
    end if
    if m.advanceAfterLoad then
        if m.episodeIndex + 1 < m.currentEps.count() then
            m.episodeIndex = m.episodeIndex + 1
            if m.episodeIndex >= m.episodeOffset + 4 then m.episodeOffset = m.episodeIndex - 3
        end if
        m.advanceAfterLoad = false
    end if
    if RestoreEpisodeSelection() then return
    print "[SeriesFocus] temporada="; seasonNumber(m.season); " episodiosEmMemoria="; m.currentEps.count(); " maisPaginas="; (m.lazyNextCursor <> "")
    drawScreen()
end sub

function MetaLine(year as String, genre as String, dur as String, age as String) as String
    genre = EmojiStrip(genre)
    parts = []
    if year <> "" then parts.push(year)
    if genre <> "" then parts.push(genre)
    if dur <> "" then parts.push(dur)
    if age <> "" then parts.push(age)
    outputText = ""
    for counter = 0 to parts.count() - 1
        if counter > 0 then outputText = outputText + "   •   "
        outputText = outputText + parts[counter]
    end for
    return outputText
end function

function DetailSeriesRef() as String
    ref = ToText(m.item.id)
    if ref = "" then ref = ToText(m.item.sourceId) + "-" + ToText(m.item.seriesId)
    return ref
end function

function SavedSeasonIndex() as Integer
    if m.restoreState = invalid then return 0
    for i = 0 to seasonCount() - 1
        if Val(seasonNumber(i)) = Val(ToText(m.restoreState.season)) then return i
    end for
    m.restorePending = false
    return 0
end function

' Se o episodio salvo estiver em outra pagina, segue os cursores ate encontra-lo.
function RestoreEpisodeSelection() as Boolean
    if not m.restorePending or m.restoreState = invalid then return false
    for i = 0 to m.currentEps.count() - 1
        if ToText(m.currentEps[i].id) = ToText(m.restoreState.episodeId) then
            m.episodeIndex = i
            m.episodeOffset = i - 3
            if m.episodeOffset < 0 then m.episodeOffset = 0
            m.restorePending = false
            return false
        end if
    end for
    if m.lazySeries and m.lazyNextCursor <> "" then
        lazyRequestEpisodes(m.lazyNextCursor)
        return true
    end if
    m.restorePending = false
    return false
end function

sub RefreshSeriesSelection()
    saved = VodReadSeriesState(DetailSeriesRef())
    if saved = invalid then return
    if m.restoreState <> invalid then
        if ToText(saved.episodeId) = ToText(m.restoreState.episodeId) then return
    end if
    m.restoreState = saved
    m.restorePending = true
    index = SavedSeasonIndex()
    if index <> m.season and seasonCount() > 0 then
        if m.lazySeries then
            lazyLoadSeason(index)
        else
            loadSeason(index)
            RestoreEpisodeSelection()
        end if
    else
        RestoreEpisodeSelection()
    end if
end sub

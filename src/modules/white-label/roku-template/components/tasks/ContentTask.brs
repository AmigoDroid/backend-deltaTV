' ============================================================
' Carrega o catalogo (URL configurada pelo usuario ou JSON local)
' e normaliza tudo para um formato unico.
' ============================================================
sub init()
    m.top.functionName = "loadCatalog"
end sub

sub loadCatalog()
    if DeltaWhiteLabelMode() then
        catalog = NormalizeCatalog({}, "white-label")
        catalog.lazy = false
        catalog.error = "Faça login para carregar sua lista."
        catalog.clearAuth = false
        if RegRead("wl_session") <> "" then
            conn = XtGetConfig()
            if conn.ok then
                catalog.lazy = true
                catalog.sources = [{id:"me",name:"Minha lista"}]
                catalog.error = ""
            else
                catalog.clearAuth = conn.clearAuth
                catalog.error = conn.message
            end if
        end if
        m.top.result = catalog
        return
    end if
    id = DeltaGetIdentity()
    accessToken = RegRead("auth_token")
    refreshToken = RegRead("refresh_token")

    if accessToken <> "" then
        ' Sempre paginado: o app nunca baixa o catalogo completo (~60 MB) na TV.
        print "[DeltaTV] build 2 - catalogo paginado (sem download do catalogo completo)"
        result = FetchLazyBootstrap(id, accessToken, refreshToken)
        if result.ok then
            m.top.result = result.catalog
            return
        end if

        ' Falha com sessao configurada: NUNCA mostrar o catalogo de demonstracao como se fosse o do cliente.
        catalog = NormalizeCatalog({}, "remote")
        catalog.error = result.message
        catalog.clearAuth = result.clearAuth
        catalog.accessToken = result.accessToken
        catalog.refreshToken = result.refreshToken
        m.top.result = catalog
        return
    end if

    m.top.result = LoadLocalCatalog("")
end sub

function LoadLocalCatalog(errorMessage as String) as Object
    ' Sem lista de demonstracao: sem sessao, o catalogo fica vazio.
    catalog = NormalizeCatalog({}, "empty")
    if errorMessage = "" then errorMessage = "Nenhuma lista configurada. Conecte este dispositivo."
    catalog.error = errorMessage
    catalog.clearAuth = false
    return catalog
end function

' Modo paginado: valida a sessao e lista as fontes autorizadas. O catalogo em si e
' carregado sob demanda pelas telas (CatalogApiTask). Retorna um catalogo "vazio" com lazy=true.
function FetchLazyBootstrap(id as Object, accessToken as String, refreshToken as String) as Object
    result = { ok: false, message: "", clearAuth: false, accessToken: accessToken, refreshToken: refreshToken }
    if not DeltaServerConfigured() then
        result.message = "Servidor não configurado (edite source/Config.brs)."
        return result
    end if

    req = HttpJson(DeltaResourcesUrl(), "GET", "", accessToken)
    if req.status = 401 and refreshToken <> "" then
        refreshed = RefreshSession(id, refreshToken)
        if not refreshed.ok then
            result.message = refreshed.message
            result.clearAuth = refreshed.clearAuth
            return result
        end if
        accessToken = refreshed.accessToken
        refreshToken = refreshed.refreshToken
        result.accessToken = accessToken
        result.refreshToken = refreshToken
        req = HttpJson(DeltaResourcesUrl(), "GET", "", accessToken)
    end if
    valid = false
    if req.status = 200 then
        if req.data <> invalid then
            if type(req.data) = "roAssociativeArray" then
                if type(req.data.sources) = "roArray" then valid = true
            end if
        end if
    end if
    if not valid then
        result.message = req.message
        if result.message = "" then result.message = "Não foi possível carregar as listas do servidor."
        ' 401/403 indicam sessão revogada, licença bloqueada/expirada ou dispositivo não autorizado.
        result.clearAuth = (req.status = 401 or req.status = 403)
        return result
    end if

    ' A reprodução Xtream é direta no fornecedor. Não solicitar play-token ao backend.

    sources = []
    for each s in req.data.sources
        if type(s) = "roAssociativeArray" and ToText(s.id) <> "" then
            sources.push({ id: ToText(s.id), name: ToText(s.name) })
        end if
    end for

    cat = NormalizeCatalog({}, "remote")
    cat.error = ""
    cat.lazy = true
    cat.sources = sources
    ' Os streams vem direto do provedor (Xtream): nenhum token do servidor Delta pode ir na URL deles.
    cat.playToken = ""
    cat.clearAuth = false
    cat.accessToken = accessToken
    cat.refreshToken = refreshToken
    result.ok = true
    result.catalog = cat
    return result
end function

' ---------- normalizacao ----------
function NormalizeCatalog(data as Object, source as String) as Object
    out = { source: source, channels: [], movies: [], series: [], featured: [], categories: [] }

    out.channels = NormList(data.channels, "channel", "c")
    out.movies = NormList(data.movies, "movie", "m")
    out.series = NormList(data.series, "series", "s")

    for each it in out.movies
        if it.featured then out.featured.push(it)
    end for
    for each it in out.series
        if it.featured then out.featured.push(it)
    end for
    if out.featured.count() = 0 then
        n = 0
        for each it in out.movies
            if n < 5 then out.featured.push(it)
            n = n + 1
        end for
        n = 0
        for each it in out.series
            if n < 5 then out.featured.push(it)
            n = n + 1
        end for
    end if

    seen = {}
    for each ch in out.channels
        if ch.category <> "" then
            if not seen.DoesExist(ch.category) then
                seen[ch.category] = true
                out.categories.push(ch.category)
            end if
        end if
    end for

    return out
end function

function NormList(list as Dynamic, kind as String, prefix as String) as Object
    res = []
    if list = invalid then return res
    if type(list) <> "roArray" then return res
    i = 0
    for each raw in list
        i = i + 1
        if type(raw) = "roAssociativeArray" then
            it = NormItem(raw, kind, prefix, i)
            if it <> invalid then res.push(it)
        end if
    end for
    return res
end function

function NormItem(raw as Object, kind as String, prefix as String, idx as Integer) as Object
    title = ToText(raw.title)
    if title = "" then title = ToText(raw.name)
    if title = "" then return invalid

    rid = ToText(raw.id)
    if rid = "" then rid = idx.toStr()

    palette = ["0x4B3A9EFF", "0x1F5F8BFF", "0x8B2F6EFF", "0x1E6B5CFF", "0x9B4A1EFF", "0x3A3F9EFF", "0x7A2A3AFF", "0x2A6F9BFF"]
    accent = ToText(raw.accent)
    if accent = "" then accent = palette[idx mod palette.count()]

    url = ToText(raw.url)
    fmt = ToText(raw.streamFormat)
    if fmt = "" then fmt = GuessStreamFormat(url)

    dur = ""
    mins = Val(ToText(raw.duration))
    if mins > 0 then
        mins = Int(mins)
        if mins >= 60 then
            hh = Int(mins / 60)
            mm = mins mod 60
            dur = hh.toStr() + "h " + mm.toStr() + "min"
        else
            dur = mins.toStr() + "min"
        end if
    end if

    featured = false
    if raw.featured <> invalid then
        if raw.featured = true then featured = true
    end if

    it = {
        id: prefix + "-" + rid,
        kind: kind,
        title: title,
        description: ToText(raw.description),
        poster: ToText(raw.poster),
        backdrop: ToText(raw.backdrop),
        yearText: ToText(raw.year),
        genreText: ToText(raw.genre),
        durationText: dur,
        ageRating: ToText(raw.rating),
        url: url,
        playPath: ToText(raw.playPath),
        playToken: ToText(raw.playToken),
        streamFormat: fmt,
        accent: accent,
        number: ToText(raw.number),
        category: ToText(raw.category),
        nowTitle: ToText(raw.now),
        nextTitle: ToText(raw["next"]),
        featured: featured,
        seasons: []
    }

    if kind = "channel" then
        if raw.logo <> invalid then it.poster = ToText(raw.logo)
    end if
    if kind = "series" then it.seasons = NormSeasons(raw.seasons)
    return it
end function

function NormSeasons(list as Dynamic) as Object
    res = []
    if list = invalid then return res
    if type(list) <> "roArray" then return res
    sn = 0
    for each s in list
        sn = sn + 1
        if type(s) = "roAssociativeArray" then
            num = ToText(s.number)
            if num = "" then num = sn.toStr()
            eps = []
            if type(s.episodes) = "roArray" then
                en = 0
                for each e in s.episodes
                    en = en + 1
                    if type(e) = "roAssociativeArray" then
                        url = ToText(e.url)
                        fmt = ToText(e.streamFormat)
                        if fmt = "" then fmt = GuessStreamFormat(url)
                        dur = ""
                        mins = Int(Val(ToText(e.duration)))
                        if mins > 0 then dur = mins.toStr() + " min"
                        t = ToText(e.title)
                        if t = "" then t = "Episódio " + en.toStr()
                        eps.push({
                            epNumber: en.toStr(),
                            title: t,
                            description: ToText(e.description),
                            durationText: dur,
                            url: url,
                            playPath: ToText(e.playPath),
                            playToken: ToText(e.playToken),
                            streamFormat: fmt
                        })
                    end if
                end for
            end if
            res.push({ number: num, episodes: eps })
        end if
    end for
    return res
end function

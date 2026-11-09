' ============================================================
' Delta TV - cliente da API Xtream Codes (player_api.php)
'
' O servidor Delta so valida a licenca e entrega a conexao do aparelho (GET /client/xtream).
' Daqui em diante e a TV que consulta o painel do provedor: categorias, canais, filmes, series e episodios,
' sob demanda e por categoria. NUNCA se baixa/gera lista M3U.
'
' Requer: Utils.brs (ToText, TrimText, RegRead/RegWrite/RegDelete, UrlEscape), Config.brs, Http.brs, DeviceId.brs.
' Use apenas dentro de Tasks (roUrlTransfer sincrono).
' ============================================================

' ---------------- conexao (painel + usuario + senha) ----------------

function XtGetConfig() as Object
    res = { ok: false, message: "", clearAuth: false, cfg: invalid }
    if not DeltaServerConfigured() then
        res.message = "Servidor não configurado (edite source/Config.brs)."
        return res
    end if

    token = RegRead("auth_token")
    if token = "" then
        res.message = "Sessão não encontrada. Reabra o aplicativo."
        return res
    end if

    previousCfg = invalid
    previousRaw = RegRead("xt_cfg")
    if previousRaw <> "" then previousCfg = ParseJson(previousRaw)
    cached = XtReadCachedConfig()
    if cached <> invalid then
        ' Verifica a licença/associação pelo servidor ao menos a cada 60 segundos.
        res.ok = true
        res.cfg = cached
        return res
    end if

    url = DeltaXtreamUrl()
    r = HttpJson(url, "GET", "", token)
    if r.status = 401 then
        ' outra Task pode ja ter renovado a sessao (o refresh token gira): reaproveita antes de renovar de novo
        current = RegRead("auth_token")
        refreshToken = RegRead("refresh_token")
        if current <> "" and current <> token then
            r = HttpJson(url, "GET", "", current)
        else if refreshToken <> "" then
            refreshed = RefreshSession(DeltaGetIdentity(), refreshToken)
            if refreshed.ok then
                RegWrite("auth_token", refreshed.accessToken)
                RegWrite("refresh_token", refreshed.refreshToken)
                r = HttpJson(url, "GET", "", refreshed.accessToken)
            else
                res.message = refreshed.message
                res.clearAuth = refreshed.clearAuth
                if refreshed.clearAuth then
                    RegDelete("auth_token")
                    RegDelete("refresh_token")
                    RegDelete("xt_cfg")
                end if
                return res
            end if
        end if
    end if

    ok = false
    if r.status = 200 and r.data <> invalid then
        if type(r.data) = "roAssociativeArray" then
            if ToText(r.data.baseUrl) <> "" and ToText(r.data.username) <> "" and ToText(r.data.password) <> "" then ok = true
        end if
    end if
    if not ok then
        res.message = r.message
        if res.message = "" then res.message = "Não foi possível obter a conexão com o provedor."
        return res
    end if

    ua = ToText(r.data.userAgent)
    if ua = "" then ua = "Mozilla/5.0"
    cfg = {
        baseUrl: ToText(r.data.baseUrl),
        username: ToText(r.data.username),
        password: ToText(r.data.password),
        userAgent: ua,
        mode: ToText(r.data.mode),
        configVersion: 44,
        at: CreateObject("roDateTime").AsSeconds()
    }
    if previousCfg <> invalid and type(previousCfg) = "roAssociativeArray" then
        if ToText(previousCfg.baseUrl) <> cfg.baseUrl or ToText(previousCfg.username) <> cfg.username or ToText(previousCfg.password) <> cfg.password then XtClearCatalogCache()
    end if
    RegWrite("xt_cfg", FormatJson(cfg))
    RegWrite("xt_ua", ua)
    res.ok = true
    res.cfg = cfg
    return res
end function

' Guarda a conexao por 60 segundos: varias telas/Tasks pedem catalogo ao mesmo tempo e nao precisam bater no servidor a cada vez.
function XtReadCachedConfig() as Object
    raw = RegRead("xt_cfg")
    if raw = "" then return invalid
    c = ParseJson(raw)
    if c = invalid then return invalid
    if type(c) <> "roAssociativeArray" then return invalid
    if c.at = invalid or c.baseUrl = invalid or c.username = invalid or c.password = invalid then return invalid
    if c.configVersion = invalid then return invalid
    if c.configVersion <> 44 then return invalid
    now = CreateObject("roDateTime").AsSeconds()
    age = now - c.at
    if age < 0 or age > 60 then return invalid
    if ToText(c.userAgent) = "" then c.userAgent = "Mozilla/5.0"
    return c
end function

sub XtForgetConfig()
    RegDelete("xt_cfg")
end sub

sub XtClearCatalogCache()
    for each root in ["tmp:/", "cachefs:/"]
        names = ListDir(root)
        if names <> invalid then
            for each f in names
                if Left(f, 3) = "xt_" or Left(f, 4) = "dtv_" then DeleteFile(root + f)
            end for
        end if
    end for
end sub

' ---------------- chamada ao painel ----------------

' GET <base>/player_api.php?username=..&password=..[&extra]  ->  { ok, status, data, message }
' Ate 3 tentativas: paineis Xtream respondem 404/5xx ou uma pagina HTML de forma intermitente.
function XtFetch(cfg as Object, extra as String, timeoutMs = 45000 as Integer) as Object
    result = { ok: false, status: -1, data: invalid, message: "" }
    url = ToText(cfg.baseUrl) + "/player_api.php?username=" + UrlEscape(ToText(cfg.username)) + "&password=" + UrlEscape(ToText(cfg.password))
    if extra <> "" then url = url + "&" + extra

    for attempt = 1 to 3
        xfer = CreateObject("roUrlTransfer")
        port = CreateObject("roMessagePort")
        xfer.SetMessagePort(port)
        xfer.SetUrl(url)
        xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
        xfer.AddHeader("User-Agent", ToText(cfg.userAgent))
        xfer.AddHeader("Accept", "application/json")
        xfer.RetainBodyOnError(true)
        xfer.EnableEncodings(true)

        if xfer.AsyncGetToString() then
            ev = wait(timeoutMs, port)
            if type(ev) = "roUrlEvent" then
                result.status = ev.GetResponseCode()
                if result.status = 200 then
                    body = XtFixSurrogates(TrimText(ev.GetString()))
                    first = Left(body, 1)
                    if first = "[" or first = "{" then
                        data = ParseJson(body)
                        if data <> invalid then
                            result.data = data
                            result.ok = true
                            return result
                        end if
                    else if LCase(body) = "null" or body = "false" then
                        result.data = []
                        result.ok = true
                        return result
                    end if
                end if
            else
                xfer.AsyncCancel()
                result.status = -1
            end if
        end if
        if attempt < 3 then sleep(400)
    end for

    result.message = "Não foi possível consultar o servidor do provedor."
    if result.status = 401 or result.status = 403 then
        result.message = "O provedor recusou o acesso (HTTP " + result.status.toStr() + "). Verifique usuário, senha e User-Agent."
    else if result.status < 0 then
        result.message = "Sem resposta do provedor (tempo esgotado)."
    else if result.status <> 200 then
        result.message = "Resposta inesperada do provedor (HTTP " + result.status.toStr() + ")."
    end if
    return result
end function

' Paineis Xtream (PHP) mandam emoji como par substituto "\ud83d\udd25". Troca pelo caractere real antes do
' ParseJson, para nao depender de como o firmware trata o par. Texto sem emoji passa direto.
function XtFixSurrogates(body as String) as String
    found = {}
    for each tag in ["\ud8", "\ud9", "\uda", "\udb", "\uD8", "\uD9", "\uDA", "\uDB"]
        scanPos = 1
        while true
            p = Instr(scanPos, body, tag)
            if p = 0 then exit while
            pair = Mid(body, p, 12)
            scanPos = p + 2
            if Len(pair) = 12 and Mid(pair, 7, 2) = "\u" then
                lo = LCase(Mid(pair, 9, 1))
                if lo = "d" then
                    found[pair] = true
                end if
            end if
        end while
    end for
    for each pair in found
        hi = Val("&h" + Mid(pair, 3, 4))
        lw = Val("&h" + Mid(pair, 9, 4))
        if lw >= 56320 and lw <= 57343 and hi >= 55296 and hi <= 56319 then
            ch = Chr(65536 + (hi - 55296) * 1024 + (lw - 56320))
            if ch <> "" then
                rx = CreateObject("roRegex", "\\u" + Mid(pair, 3, 4) + "\\u" + Mid(pair, 9, 4), "i")
                body = rx.ReplaceAll(body, ch)
            end if
        end if
    end for
    return body
end function

' ---------------- cache em tmp:/ (nunca guarda usuario/senha) ----------------

function XtSafe(s as String) as String
    out = ""
    for i = 1 to Len(s)
        ch = Mid(s, i, 1)
        c = Asc(ch)
        if (c >= 48 and c <= 57) or (c >= 65 and c <= 90) or (c >= 97 and c <= 122) then
            out = out + ch
        else
            out = out + "x"
        end if
    end for
    return out
end function

function XtCachePath(key as String) as String
    return "tmp:/xt_" + XtSafe(key) + ".json"
end function

function XtCacheRead(key as String, maxAgeSec as Integer) as Object
    path = XtCachePath(key)
    fs = CreateObject("roFileSystem")
    if not fs.Exists(path) then return invalid
    s = ReadAsciiFile(path)
    if s = "" then return invalid
    d = ParseJson(s)
    if d = invalid then return invalid
    if type(d) <> "roAssociativeArray" then return invalid
    if d.at = invalid then return invalid
    age = CreateObject("roDateTime").AsSeconds() - d.at
    if age < 0 or age > maxAgeSec then return invalid
    return d
end function

sub XtCacheWrite(key as String, payload as Object)
    ' poucos arquivos: passou de 8, limpa tudo (o cache e so otimizacao)
    names = ListDir("tmp:/")
    n = 0
    for each f in names
        if Left(f, 3) = "xt_" then n = n + 1
    end for
    if n >= 8 then
        for each f in names
            if Left(f, 3) = "xt_" then DeleteFile("tmp:/" + f)
        end for
    end if
    payload.at = CreateObject("roDateTime").AsSeconds()
    WriteAsciiFile(XtCachePath(key), FormatJson(payload))
end sub

' ---------------- URLs de reproducao ----------------

function XtStreamUrl(cfg as Object, section as String, id as String, ext as String) as String
    return ToText(cfg.baseUrl) + "/" + section + "/" + UrlEscape(ToText(cfg.username)) + "/" + UrlEscape(ToText(cfg.password)) + "/" + id + "." + ext
end function

' ---------------- consultas (formato igual ao da antiga API /client/catalog) ----------------

function XtGroups(cfg as Object, kind as String) as Object
    action = "get_live_categories"
    if kind = "movie" then action = "get_vod_categories"
    if kind = "series" then action = "get_series_categories"
    r = XtFetch(cfg, "action=" + action)
    if not r.ok then return r
    groups = []
    if type(r.data) = "roArray" then
        for each c in r.data
            if type(c) = "roAssociativeArray" then
                gid = ToText(c.category_id)
                if gid <> "" then groups.push({ id: gid, name: ToText(c.category_name), itemCount: 0 })
            end if
        end for
    end if
    r.data = { groups: groups, outdated: false }
    return r
end function

' Lista (ja reduzida) de UMA categoria. Baixa do painel so na primeira vez; as proximas paginas vem do cache.
function XtCategoryList(cfg as Object, kind as String, groupId as String, writeCache = true as Boolean) as Object
    key = kind + "_" + groupId
    cached = XtCacheRead(key, 600)
    if cached <> invalid and type(cached.items) = "roArray" then return { ok: true, items: cached.items, message: "" }

    action = "get_live_streams"
    if kind = "movie" then action = "get_vod_streams"
    if kind = "series" then action = "get_series"
    r = XtFetch(cfg, "action=" + action + "&category_id=" + UrlEscape(groupId))
    if not r.ok then return { ok: false, items: [], message: r.message }

    items = []
    if type(r.data) = "roArray" then
        for each s in r.data
            if type(s) = "roAssociativeArray" then
                if kind = "series" then
                    sid = ToText(s.series_id)
                    if sid <> "" then items.push({ sid: sid, title: ToText(s.name), logo: ToText(s.cover), ext: "" })
                else
                    sid = ToText(s.stream_id)
                    if sid <> "" then
                        ext = ""
                        if kind = "movie" then
                            ext = LCase(ToText(s.container_extension))
                            if ext = "" then ext = "mp4"
                        end if
                        items.push({ sid: sid, title: ToText(s.name), logo: ToText(s.stream_icon), ext: ext })
                    end if
                end if
            end if
        end for
    end if
    if writeCache then XtCacheWrite(key, { items: items })
    return { ok: true, items: items, message: "" }
end function

function XtItemOut(cfg as Object, kind as String, groupId as String, s as Object) as Object
    out = {
        id: ToText(s.sid) + "_" + groupId,
        kind: kind,
        title: ToText(s.title),
        logo: ToText(s.logo),
        groupId: groupId,
        ext: ""
    }
    if kind = "live" then
        ' .m3u8 primeiro; o PlayerScreen tenta .ts se o aparelho nao abrir (LiveCandidates)
        out.id = "l" + out.id
        out.ext = ".m3u8"
        out.srcVideo = XtStreamUrl(cfg, "live", ToText(s.sid), "m3u8")
    else
        out.id = "m" + out.id
        out.ext = "." + ToText(s.ext)
        out.srcVideo = XtStreamUrl(cfg, "movie", ToText(s.sid), ToText(s.ext))
    end if
    return out
end function

' Pagina por cursor = posicao (texto). Devolve { start, stop, next } ("" = fim).
function XtPage(total as Integer, cursor as String, pageSize as String) as Object
    start = 0
    if cursor <> "" then start = Int(Val(cursor))
    if start < 0 then start = 0
    size = 40
    if pageSize <> "" then size = Int(Val(pageSize))
    if size < 1 then size = 1
    if size > 100 then size = 100
    endIdx = start + size
    nextCursor = ""
    if endIdx < total then
        nextCursor = endIdx.toStr()
    else
        endIdx = total
    end if
    return { start: start, endIdx: endIdx, nextCur: nextCursor }
end function

function XtItems(cfg as Object, kind as String, groupId as String, cursor as String, pageSize as String) as Object
    lst = XtCategoryList(cfg, kind, groupId)
    if not lst.ok then return { ok: false, status: 502, data: invalid, message: lst.message }
    pg = XtPage(lst.items.count(), cursor, pageSize)
    out = []
    for i = pg.start to pg.endIdx - 1
        out.push(XtItemOut(cfg, kind, groupId, lst.items[i]))
    end for
    data = { items: out, outdated: false, total: lst.items.count() }
    if pg.nextCur <> "" then data.nextCursor = pg.nextCur
    return { ok: true, status: 200, data: data, message: "" }
end function

function XtSeriesList(cfg as Object, groupId as String, cursor as String, pageSize as String) as Object
    lst = XtCategoryList(cfg, "series", groupId)
    if not lst.ok then return { ok: false, status: 502, data: invalid, message: lst.message }
    pg = XtPage(lst.items.count(), cursor, pageSize)
    out = []
    for i = pg.start to pg.endIdx - 1
        s = lst.items[i]
        out.push({ id: ToText(s.sid), title: ToText(s.title), logo: ToText(s.logo), groupId: groupId, seasonCount: 0, episodeCount: 0 })
    end for
    data = { series: out, outdated: false }
    if pg.nextCur <> "" then data.nextCursor = pg.nextCur
    return { ok: true, status: 200, data: data, message: "" }
end function

' Episodios de uma serie (get_series_info), reduzidos a uma lista plana [{ id, season, num, title, ext }].
function XtSeriesEpisodes(cfg as Object, seriesId as String) as Object
    key = "info_" + seriesId
    cached = XtCacheRead(key, 600)
    if cached <> invalid and type(cached.episodes) = "roArray" then return { ok: true, episodes: cached.episodes, message: "" }

    r = XtFetch(cfg, "action=get_series_info&series_id=" + UrlEscape(seriesId))
    if not r.ok then return { ok: false, episodes: [], message: r.message }

    flat = []
    if type(r.data) = "roAssociativeArray" then
        eps = r.data.episodes
        if type(eps) = "roAssociativeArray" then
            for each seasonKey in eps
                XtCollectEpisodes(flat, eps[seasonKey], Int(Val(seasonKey)))
            end for
        else if type(eps) = "roArray" then
            idx = 0
            for each group in eps
                idx = idx + 1
                XtCollectEpisodes(flat, group, idx)
            end for
        end if
    end if
    XtCacheWrite(key, { episodes: flat })
    return { ok: true, episodes: flat, message: "" }
end function

sub XtCollectEpisodes(flat as Object, list as Dynamic, fallbackSeason as Integer)
    if type(list) <> "roArray" then return
    for each e in list
        if type(e) = "roAssociativeArray" then
            eid = ToText(e.id)
            if eid <> "" then
                season = fallbackSeason
                if e.season <> invalid then season = Int(Val(ToText(e.season)))
                ext = LCase(ToText(e.container_extension))
                if ext = "" then ext = "mp4"
                flat.push({ id: eid, season: season, num: Int(Val(ToText(e.episode_num))), title: ToText(e.title), ext: ext })
            end if
        end if
    end for
end sub

function XtSeasons(cfg as Object, seriesId as String) as Object
    r = XtSeriesEpisodes(cfg, seriesId)
    if not r.ok then return { ok: false, status: 502, data: invalid, message: r.message }
    nums = []
    counts = {}
    for each e in r.episodes
        k = ToText(e.season)
        if not counts.DoesExist(k) then
            counts[k] = 0
            nums.push(e.season)
        end if
        counts[k] = counts[k] + 1
    end for
    nums.sort()
    seasons = []
    for each n in nums
        seasons.push({ season: n, episodeCount: counts[ToText(n)] })
    end for
    return { ok: true, status: 200, data: { seasons: seasons, outdated: false }, message: "" }
end function

function XtEpisodes(cfg as Object, seriesId as String, season as String, cursor as String, pageSize as String) as Object
    r = XtSeriesEpisodes(cfg, seriesId)
    if not r.ok then return { ok: false, status: 502, data: invalid, message: r.message }
    picked = []
    for each e in r.episodes
        if season = "" or ToText(e.season) = season then picked.push(e)
    end for
    pg = XtPage(picked.count(), cursor, pageSize)
    out = []
    for i = pg.start to pg.endIdx - 1
        e = picked[i]
        out.push({
            id: ToText(e.id),
            kind: "series",
            title: ToText(e.title),
            episodeTitle: ToText(e.title),
            season: e.season,
            episode: e.num,
            seriesId: seriesId,
            ext: "." + ToText(e.ext),
            srcVideo: XtStreamUrl(cfg, "series", ToText(e.id), ToText(e.ext))
        })
    end for
    data = { episodes: out, outdated: false }
    if pg.nextCur <> "" then data.nextCursor = pg.nextCur
    return { ok: true, status: 200, data: data, message: "" }
end function

' Favoritos: o id guardado ("l<stream>_<categoria>" / "m<vod>_<categoria>") basta para achar o item na categoria.
function XtFavoriteSeries(cfg as Object, seriesId as String) as Object
    if seriesId = "" then return { ok: false, status: 404, data: invalid, message: "Série não encontrada." }
    r = XtFetch(cfg, "action=get_series_info&series_id=" + UrlEscape(seriesId))
    if not r.ok then return { ok: false, status: 502, data: invalid, message: r.message }
    if type(r.data) = "roAssociativeArray" then
        info = r.data.info
        if type(info) = "roAssociativeArray" then
            if ToText(info.name) <> "" then
                item = { id: seriesId, kind: "series", title: ToText(info.name), logo: ToText(info.cover), srcVideo: "" }
                return { ok: true, status: 200, data: { item: item }, message: "" }
            end if
        end if
    end if
    return { ok: false, status: 404, data: invalid, message: "Série não encontrada." }
end function

function XtItemById(cfg as Object, itemId as String) as Object
    notFound = { ok: false, status: 404, data: invalid, message: "Item não encontrado." }
    if Left(itemId, 1) = "s" then return XtFavoriteSeries(cfg, Mid(itemId, 2))
    if Len(itemId) < 3 then return notFound
    kind = ""
    head = Left(itemId, 1)
    if head = "l" then kind = "live"
    if head = "m" then kind = "movie"
    if kind = "" then return notFound
    body = Mid(itemId, 2)
    cut = Instr(1, body, "_")
    if cut < 2 then return notFound
    sid = Left(body, cut - 1)
    groupId = Mid(body, cut + 1)
    if groupId = "" then return notFound

    lst = XtCategoryList(cfg, kind, groupId)
    if not lst.ok then return { ok: false, status: 502, data: invalid, message: lst.message }
    for each s in lst.items
        if ToText(s.sid) = sid then
            return { ok: true, status: 200, data: { item: XtItemOut(cfg, kind, groupId, s), outdated: false }, message: "" }
        end if
    end for
    return notFound
end function

' ---------------- busca ----------------

' minusculas e sem acento ("Ação" -> "acao"): a busca ignora maiusculas e acentos
function XtSearchNorm(s as String) as String
    out = ""
    for i = 1 to Len(s)
        ch = Mid(s, i, 1)
        c = Asc(ch)
        if c < 128 then
            out = out + LCase(ch)
        else if (c >= 224 and c <= 229) or (c >= 192 and c <= 197) then
            out = out + "a"
        else if c = 231 or c = 199 then
            out = out + "c"
        else if (c >= 232 and c <= 235) or (c >= 200 and c <= 203) then
            out = out + "e"
        else if (c >= 236 and c <= 239) or (c >= 204 and c <= 207) then
            out = out + "i"
        else if c = 241 or c = 209 then
            out = out + "n"
        else if (c >= 242 and c <= 246) or (c >= 210 and c <= 214) then
            out = out + "o"
        else if (c >= 249 and c <= 252) or (c >= 217 and c <= 220) then
            out = out + "u"
        else if c = 253 or c = 255 or c = 221 then
            out = out + "y"
        else
            out = out + ch
        end if
    end for
    return out
end function

' Lista COMPLETA (filmes ou series) numa unica chamada ao painel: get_vod_streams / get_series SEM category_id.
' Guarda so o essencial de cada item (ja reduzido) em cache por 10 min; a pesquisa varre essa lista.
function XtAllList(cfg as Object, kind as String, useCache = true as Boolean) as Object
    key = "all_" + kind
    if useCache then
        cached = XtCacheRead(key, 600)
        if cached <> invalid and type(cached.items) = "roArray" then return { ok: true, items: cached.items, message: "" }
    end if

    action = "get_vod_streams"
    if kind = "series" then action = "get_series"
    if kind = "live" then action = "get_live_streams"
    r = XtFetch(cfg, "action=" + action, 90000)
    if not r.ok then return { ok: false, items: [], message: r.message }

    items = []
    if type(r.data) = "roArray" then
        for each s in r.data
            if type(s) = "roAssociativeArray" then
                if kind = "series" then
                    sid = ToText(s.series_id)
                    if sid <> "" then items.push({ sid: sid, title: ToText(s.name), logo: ToText(s.cover), ext: "", cat: ToText(s.category_id) })
                else
                    sid = ToText(s.stream_id)
                    if sid <> "" then
                        ext = LCase(ToText(s.container_extension))
                        if ext = "" then ext = "mp4"
                        items.push({ sid: sid, title: ToText(s.name), logo: ToText(s.stream_icon), ext: ext, cat: ToText(s.category_id) })
                    end if
                end if
            end if
        end for
    end if
    r = invalid ' libera a resposta bruta antes de gravar o cache
    if useCache then XtCacheWrite(key, { items: items })
    return { ok: true, items: items, message: "" }
end function

' Pesquisa em TODO o catalogo (filmes ou series) de uma vez, usando a lista completa do painel (XtAllList).
' Ignora maiusculas e acentos. Resposta no mesmo formato de XtItems / XtSeriesList, com "sid" (sem duplicados)
' e "groupId" (categoria do item). Devolve ate "limit" resultados.
function XtSearchAll(cfg as Object, kind as String, term as String, limit as Integer) as Object
    lst = XtAllList(cfg, kind)
    if not lst.ok then return { ok: false, status: 502, data: invalid, message: lst.message }

    termN = XtSearchNorm(TrimText(term))
    nonAscii = CreateObject("roRegex", "[^ -~]", "")
    out = []
    if termN <> "" then
        for each s in lst.items
            title = ToText(s.title)
            hit = (Instr(1, LCase(title), termN) > 0)
            if not hit and nonAscii.IsMatch(title) then hit = (Instr(1, XtSearchNorm(title), termN) > 0)
            if hit then
                gid = ToText(s.cat)
                if kind = "series" then
                    out.push({ id: ToText(s.sid), sid: ToText(s.sid), title: title, logo: ToText(s.logo), groupId: gid, seasonCount: 0, episodeCount: 0 })
                else
                    o = XtItemOut(cfg, kind, gid, s)
                    o.sid = ToText(s.sid)
                    out.push(o)
                end if
                if out.count() >= limit then exit for
            end if
        end for
    end if

    data = { outdated: false, total: out.count() }
    if kind = "series" then
        data.series = out
    else
        data.items = out
    end if
    return { ok: true, status: 200, data: data, message: "" }
end function

' Procura o termo nos titulos de UMA categoria (o app chama categoria por categoria: nunca ha o catalogo
' inteiro na memoria). Resposta no mesmo formato de XtItems / XtSeriesList, com "sid" para tirar duplicados.
function XtSearch(cfg as Object, kind as String, groupId as String, term as String) as Object
    lst = XtCategoryList(cfg, kind, groupId, false) ' nao grava cache: a busca varre tudo e nao deve expulsar o cache da navegacao
    if not lst.ok then return { ok: false, status: 502, data: invalid, message: lst.message }

    termN = XtSearchNorm(TrimText(term))
    nonAscii = CreateObject("roRegex", "[^ -~]", "")
    out = []
    if termN <> "" then
        for each s in lst.items
            title = ToText(s.title)
            hit = (Instr(1, LCase(title), termN) > 0)
            if not hit and nonAscii.IsMatch(title) then hit = (Instr(1, XtSearchNorm(title), termN) > 0)
            if hit then
                if kind = "series" then
                    out.push({ id: ToText(s.sid), sid: ToText(s.sid), title: title, logo: ToText(s.logo), groupId: groupId, seasonCount: 0, episodeCount: 0 })
                else
                    o = XtItemOut(cfg, kind, groupId, s)
                    o.sid = ToText(s.sid)
                    out.push(o)
                end if
                if out.count() >= 100 then exit for
            end if
        end for
    end if

    data = { outdated: false }
    if kind = "series" then
        data.series = out
    else
        data.items = out
    end if
    return { ok: true, status: 200, data: data, message: "" }
end function


' ============================================================
' Memoria local do catalogo (pre-carregada ao abrir o app)
'
' O PreloadTask baixa a lista COMPLETA de cada tipo (live / movie / series) e grava em cachefs:/ (persistente; tmp:/ so como reserva):
'   dtv_<tipo>_<categoria>.d   uma linha por item:  sid TAB ext TAB ["titulo","capa"]   (ASCII puro)
'   dtv_<tipo>.i               indice de pesquisa:  texto-normalizado TAB categoria TAB numero-da-linha
'   dtv_<tipo>.m               manifesto (categorias, contagens) - gravado POR ULTIMO: so existe se tudo deu certo
' Quem consulta (CatalogApiTask) le so o arquivo da categoria pedida, na propria thread: nada de copiar listas grandes
' entre threads, a tela nunca trava. So a URL da capa fica guardada; a imagem e baixada quando a celula aparece.
' ============================================================

' PERSISTENTE: o catalogo fica em cachefs:/ (sobrevive a fechar o app e a reiniciar o Roku). Se o aparelho nao
' deixar gravar la, usa tmp:/ (so enquanto o app/aparelho nao reinicia). A escolha fica no registro (mem_root).
function XtMemRoot() as String
    r = RegRead("mem_root")
    if r = "cachefs:/" then return r
    return "tmp:/"
end function

' testa a gravacao em cachefs:/ e guarda a escolha (chamado pelo PreloadTask antes de baixar)
sub XtMemPickRoot()
    probe = "cachefs:/dtv_probe.t"
    if WriteAsciiFile(probe, "ok") and ReadAsciiFile(probe) = "ok" then
        RegWrite("mem_root", "cachefs:/")
    else
        RegWrite("mem_root", "tmp:/")
    end if
    DeleteFile(probe)
end sub

' impressao digital do provedor+usuario (hash; nunca guarda usuario/senha): o cache de outra lista nao e usado
function XtMemFingerprint() as String
    c = XtStoredConfig()
    if c = invalid then return ""
    ba = CreateObject("roByteArray")
    ba.FromAsciiString(ToText(c.baseUrl) + "|" + ToText(c.username))
    d = CreateObject("roEVPDigest")
    d.Setup("md5")
    return d.Process(ba)
end function

function XtMemPath(kind as String, suffix as String) as String
    return XtMemRoot() + "dtv_" + kind + suffix
end function

function XtMemCatPath(kind as String, gid as String) as String
    return XtMemRoot() + "dtv_" + kind + "_" + XtSafe(gid) + ".d"
end function

sub XtMemClearKind(kind as String)
    DeleteFile(XtMemPath(kind, ".m")) ' manifesto primeiro: a partir daqui o tipo deixa de ser usado
    prefix = "dtv_" + kind
    for each root in ["tmp:/", "cachefs:/"]
        names = ListDir(root)
        if names <> invalid then
            for each f in names
                if Left(f, Len(prefix)) = prefix then DeleteFile(root + f)
            end for
        end if
    end for
end sub

sub XtMemClear()
    for each k in ["live", "movie", "series"]
        XtMemClearKind(k)
    end for
end sub

' junta linhas com LF em O(n log n) (concatenar uma a uma seria quadratico)
function XtJoinLines(a as Object) as String
    if a.count() = 0 then return ""
    nl = Chr(10)
    while a.count() > 1
        b = []
        i = 0
        while i < a.count()
            if i + 1 < a.count() then
                b.push(a[i] + nl + a[i + 1])
            else
                b.push(a[i])
            end if
            i = i + 2
        end while
        a = b
    end while
    return a[0]
end function

' texto de pesquisa: minusculo, sem acento, so ASCII, sem TAB/LF
function XtSearchKey(title as String, nonAscii as Object) as String
    if nonAscii.IsMatch(title) then
        t = XtSearchNorm(title)
        t = nonAscii.ReplaceAll(t, "")
    else
        t = LCase(title)
    end if
    return t
end function

' items: [{ sid, title, logo, ext, cat }]. Devolve false se nao coube / falhou (nada fica gravado nesse caso).
' Memoria: so as REFERENCIAS dos itens sao agrupadas por categoria; o texto (linhas, chaves de busca, offsets) e montado
' e gravado UMA categoria por vez e solto logo em seguida. Antes, o texto de todas as categorias existia ao mesmo tempo.
' O formato dos arquivos (.d, .i, .m) nao mudou: o cache ja salvo continua valido.
function XtMemWrite(kind as String, groups as Object, items as Object) as Boolean
    XtMemClearKind(kind)
    nonAscii = CreateObject("roRegex", "[^ -~]", "")
    tb = Chr(9)

    ' passo 1: agrupa referencias por categoria
    byCat = {}
    order = []
    n = 0
    for each s in items
        key = "k" + ToText(s.cat)
        if byCat[key] = invalid then
            byCat[key] = { id: ToText(s.cat), items: [] }
            order.push(key)
        end if
        byCat[key].items.push(s)
        n = n + 1
        if n mod 4000 = 0 then sleep(2) ' cede CPU: a tela nao pode engasgar durante o pre-carregamento
    end for

    ' passo 2: uma categoria por vez (monta, grava, solta); so o indice de busca acumula
    idx = []
    counts = {}
    n = 0
    for each key in order
        c = byCat[key]
        lines = []
        ks = []
        offs = []
        sids = []
        lineOff = 0
        for each s in c.items
            ln0 = ToText(s.sid) + tb + ToText(s.ext) + tb + FormatJson([ToText(s.title), ToText(s.logo)])
            sids.push(ToText(s.sid))
            offs.push(lineOff) ' posicao da linha no arquivo da categoria (ASCII: 1 caractere = 1 byte)
            lineOff = lineOff + Len(ln0) + 1
            lines.push(ln0)
            ks.push(XtSearchKey(ToText(s.title), nonAscii))
            n = n + 1
            if n mod 2000 = 0 then sleep(2)
        end for
        c.items = invalid
        byCat[key] = invalid

        text = XtJoinLines(lines)
        okWrite = WriteAsciiFile(XtMemCatPath(kind, c.id), text)
        text = invalid
        if not okWrite then
            XtMemClearKind(kind)
            return false
        end if
        counts[key] = lines.count()
        for i = 0 to ks.count() - 1
            idx.push(ks[i] + tb + c.id + tb + offs[i].toStr() + tb + Len(lines[i]).toStr() + tb + sids[i] + tb + i.toStr())
        end for
        lines = invalid
        ks = invalid
        offs = invalid
        sids = invalid
    end for
    byCat = invalid

    idxText = XtJoinLines(idx)
    idx = invalid
    if not WriteAsciiFile(XtMemPath(kind, ".i"), idxText) then
        XtMemClearKind(kind)
        return false
    end if
    idxText = invalid

    man = { v: 3, groups: groups, cats: counts, total: items.count(), at: CreateObject("roDateTime").AsSeconds(), fp: XtMemFingerprint() }
    if not WriteAsciiFile(XtMemPath(kind, ".m"), FormatJson(man)) then
        XtMemClearKind(kind)
        return false
    end if
    return true
end function

' manifesto valido (existe e tem menos de 3 horas) ou invalid
function XtMemManifest(kind as String) as Object
    if kind <> "live" and kind <> "movie" and kind <> "series" then return invalid
    if not CreateObject("roFileSystem").Exists(XtMemPath(kind, ".m")) then return invalid ' ainda baixando: sem erro no log
    raw = ReadAsciiFile(XtMemPath(kind, ".m"))
    if raw = "" then return invalid
    man = ParseJson(raw)
    if man = invalid then return invalid
    if type(man) <> "roAssociativeArray" then return invalid
    if man.at = invalid or man.cats = invalid then return invalid
    if man.v <> 3 then return invalid
    ' da mesma lista/usuario (senao e cache de outra conta) e com no maximo 7 dias: abre na hora; o PreloadTask atualiza em segundo plano
    fpNow = XtMemFingerprint()
    if fpNow = "" or ToText(man.fp) <> fpNow then return invalid
    age = CreateObject("roDateTime").AsSeconds() - man.at
    if age < 0 or age > 604800 then return invalid
    return man
end function

' idade (segundos) do catalogo salvo de um tipo; -1 se nao ha cache valido
function XtMemAge(kind as String) as Integer
    man = XtMemManifest(kind)
    if man = invalid then return -1
    return CreateObject("roDateTime").AsSeconds() - man.at
end function

' conexao guardada (sem exigir os 60s do cache de rede): so serve para montar as URLs de reproducao
function XtStoredConfig() as Object
    raw = RegRead("xt_cfg")
    if raw = "" then return invalid
    c = ParseJson(raw)
    if c = invalid then return invalid
    if type(c) <> "roAssociativeArray" then return invalid
    if ToText(c.baseUrl) = "" or ToText(c.username) = "" or ToText(c.password) = "" then return invalid
    if ToText(c.userAgent) = "" then c.userAgent = "Mozilla/5.0"
    return c
end function

' linhas (texto) de uma categoria; invalid se o arquivo nao pode ser lido
function XtMemCatLines(kind as String, gid as String, man as Object) as Object
    if man.cats["k" + gid] = invalid then return [] ' categoria sem itens
    raw = ReadAsciiFile(XtMemCatPath(kind, gid))
    if raw = "" then return invalid
    return raw.Split(Chr(10))
end function

' "sid TAB ext TAB [titulo,capa]" -> { sid, ext, title, logo } (ou invalid)
function XtMemParseLine(line as String) as Object
    f = line.Split(Chr(9))
    if f.count() < 3 then return invalid
    j = ParseJson(f[2])
    if j = invalid then return invalid
    if type(j) <> "roArray" then return invalid
    if j.count() < 2 then return invalid
    return { sid: f[0], ext: f[1], title: ToText(j[0]), logo: ToText(j[1]) }
end function

' Responde a mesma rota do CatalogApiTask a partir da memoria local.
' invalid = nao tem (ainda nao carregou / rota que depende do provedor): quem chamou usa a rede.
function XtMemQuery(path as String, q as Object) as Object
    kind = ToText(q.kind)

    if path = "groups" then
        man = XtMemManifest(kind)
        if man = invalid then return invalid
        return { ok: true, status: 200, data: { groups: man.groups, outdated: false }, message: "" }

    else if path = "items" or path = "series" then
        if path = "series" then kind = "series"
        man = XtMemManifest(kind)
        if man = invalid then return invalid
        cfg = XtStoredConfig()
        if cfg = invalid then
            print "[DeltaTV][TRACE] XtMemSearchFast: PAROU XtStoredConfig retornou invalid"
            return invalid
        end if
        gid = ToText(q.groupId)
        lines = XtMemCatLines(kind, gid, man)
        if lines = invalid then return invalid
        pg = XtPage(lines.count(), ToText(q.cursor), ToText(q.pageSize))
        out = []
        for i = pg.start to pg.endIdx - 1
            s = XtMemParseLine(lines[i])
            if s <> invalid then
                if kind = "series" then
                    out.push({ id: s.sid, title: s.title, logo: s.logo, groupId: gid, seasonCount: 0, episodeCount: 0 })
                else
                    out.push(XtItemOut(cfg, kind, gid, s))
                end if
            end if
        end for
        if kind = "series" then
            data = { series: out, outdated: false }
        else
            data = { items: out, outdated: false, total: lines.count() }
        end if
        if pg.nextCur <> "" then data.nextCursor = pg.nextCur
        return { ok: true, status: 200, data: data, message: "" }

    else if path = "search" then
        if ToText(q.groupId) <> "" then return invalid
        return XtMemSearch(kind, ToText(q.term), 300)

    else if Left(path, 6) = "items/" then
        ' favorito: "l<stream>_<pasta>" / "m<vod>_<pasta>"
        itemId = Mid(path, 7)
        head = Left(itemId, 1)
        k = ""
        if head = "l" then k = "live"
        if head = "m" then k = "movie"
        if k = "" then return invalid
        man = XtMemManifest(k)
        cfg = XtStoredConfig()
        if man = invalid or cfg = invalid then return invalid
        body = Mid(itemId, 2)
        cut = Instr(1, body, "_")
        if cut < 2 then return invalid
        sid = Left(body, cut - 1)
        gid = Mid(body, cut + 1)
        lines = XtMemCatLines(k, gid, man)
        if lines = invalid then return invalid
        prefix = sid + Chr(9)
        for each line in lines
            if Left(line, Len(prefix)) = prefix then
                s = XtMemParseLine(line)
                if s <> invalid then return { ok: true, status: 200, data: { item: XtItemOut(cfg, k, gid, s), outdated: false }, message: "" }
            end if
        end for
        return { ok: false, status: 404, data: invalid, message: "Item não encontrado." }
    end if
    return invalid ' temporadas / episodios: pedidos ao provedor ao abrir o titulo
end function

' Pesquisa no catalogo inteiro. "st" e o estado da Task de pesquisa (fica entre chamadas):
'   - o indice (texto unico) so e lido do disco uma vez por tipo;
'   - digitar mais uma letra filtra so os candidatos da busca anterior (sem varrer o catalogo de novo);
'   - as categorias lidas ficam em cache. Sem Task permanente, passe st = {} (tudo e relido a cada chamada).
function XtMemSearch(kind as String, term as String, limit as Integer) as Object
    return XtMemSearchFast({}, kind, term, limit)
end function

function XtMemSearchFast(st as Object, kind as String, term as String, limit as Integer) as Object
    print "[DeltaTV][TRACE] XtMemSearchFast: ENTRADA kind=" + kind + " term=[" + term + "] limit=" + limit.toStr()
    if kind <> "movie" and kind <> "series" then
        print "[DeltaTV][TRACE] XtMemSearchFast: PAROU kind invalido=[" + kind + "]"
        return invalid
    end if

    ' manifesto em cache por 5 s (so confere se a lista foi recarregada)
    if st.clk = invalid then st.clk = CreateObject("roTimespan")
    if st.man = invalid then st.man = {}
    mm = st.man[kind]
    stale = true
    if mm <> invalid then
        if st.clk.TotalMilliseconds() - mm.t <= 5000 then stale = false
    end if
    if stale then
        man0 = XtMemManifest(kind)
        if man0 = invalid then
            print "[DeltaTV][TRACE] XtMemSearchFast: PAROU XtMemManifest retornou invalid"
            st.man[kind] = invalid
            return invalid
        end if
        mm = { man: man0, t: st.clk.TotalMilliseconds() }
        st.man[kind] = mm
    end if
    man = mm.man
    cfg = st.cfg
    cfgStale = true
    if cfg <> invalid and st.cfgT <> invalid then
        if st.clk.TotalMilliseconds() - st.cfgT <= 5000 then cfgStale = false
    end if
    if cfgStale then
        cfg = XtStoredConfig()
        if cfg = invalid then return invalid
        st.cfg = cfg
        st.cfgT = st.clk.TotalMilliseconds()
    end if

    ' indice do tipo (relido so se a lista foi recarregada). Linha: texto TAB categoria TAB offset TAB tamanho
    k = st[kind]
    reload = true
    if k <> invalid then
        if k.at = man.at then reload = false
    end if
    if reload then
        text0 = ReadAsciiFile(XtMemPath(kind, ".i"))
        if text0 = "" and man.total > 0 then
            print "[DeltaTV][TRACE] XtMemSearchFast: PAROU indice vazio, total manifesto=" + man.total.toStr()
            return invalid
        end if
        k = { at: man.at, text: Chr(10) + text0 } ' LF no comeco: toda linha passa a ser precedida de LF
        text0 = invalid
        st[kind] = k
    end if
    text = k.text

    nonAscii = CreateObject("roRegex", "[^ -~]", "")
    termN = TrimText(XtSearchKey(TrimText(term), nonAscii))
    print "[DeltaTV][TRACE] XtMemSearchFast: termo normalizado=[" + termN + "] indiceLen=" + Len(text).toStr()
    nl = Chr(10)
    tb = Chr(9)
    out = []
    total = Len(text)

    ' Tres passadas com Instr nativo, ja em ordem de relevancia, e PARA ao juntar "limit" resultados:
    '   0 = titulo COMECA com o termo; 1 = uma palavra comeca com ele; 2 = no meio.
    ' Termo curto acha 120 resultados quase de imediato; termo raro varre o indice 3 vezes (rapido, e nativo).
    ranked = []
    if termN <> "" and total > 1 then
        seen = {}
        needles = [nl + termN, " " + termN, termN]
        for pass = 0 to 2
            needle = needles[pass]
            p = Instr(1, text, needle)
            while p > 0 and ranked.count() < limit
                if pass = 0 then
                    ls = p + 1
                else
                    ls = p
                    while ls > 1 and Mid(text, ls - 1, 1) <> nl
                        ls = ls - 1
                    end while
                end if
                le = Instr(ls, text, nl)
                if le = 0 then le = total + 1
                key = ls.toStr()
                if not seen.DoesExist(key) then
                    f = Mid(text, ls, le - ls).Split(tb)
                    if f.count() = 6 then
                        if Instr(1, f[0], termN) > 0 then ' garante que o acerto esta no titulo (nao nos numeros)
                            seen[key] = true
                            ranked.push(f)
                        end if
                    end if
                end if
                if le > total then exit while
                if pass = 0 then
                    p = Instr(le, text, needle) ' o LF do fim desta linha ja e o comeco do proximo "LF + termo"
                else
                    p = Instr(le + 1, text, needle)
                end if
            end while
            if ranked.count() >= limit then exit for
        end for
    end if

    ' le so a linha de cada resultado (por offset), em vez da categoria inteira
    for each f in ranked
        gid = f[1]
        line = XtMemReadLine(kind, gid, Int(Val(f[2])), Int(Val(f[3])))
        if Left(line, Len(f[4]) + 1) <> f[4] + tb then
            ' offset nao bateu (seguranca): le a categoria inteira (uma vez, fica em cache) e pega a linha pelo numero
            if st.cats = invalid then st.cats = {}
            if st.catN = invalid then st.catN = 0
            ck = kind + "|" + gid + "|" + Str(man.at).Trim()
            cl = st.cats[ck]
            if cl = invalid then
                cl = XtMemCatLines(kind, gid, man)
                if cl = invalid then cl = []
                if st.catN >= 30 then
                    st.cats = {}
                    st.catN = 0
                end if
                st.cats[ck] = cl
                st.catN = st.catN + 1
            end if
            n = Int(Val(f[5]))
            line = ""
            if n >= 0 and n < cl.count() then line = cl[n]
            st.misses = Val(ToText(st.misses)) + 1
        end if
        if line <> "" then
            s = XtMemParseLine(line)
            if s <> invalid then
                if kind = "series" then
                    out.push({ id: s.sid, sid: s.sid, title: s.title, logo: s.logo, groupId: gid, seasonCount: 0, episodeCount: 0 })
                else
                    o = XtItemOut(cfg, kind, gid, s)
                    o.sid = s.sid
                    out.push(o)
                end if
            end if
        end if
    end for

    print "[DeltaTV] busca: termo=" + termN + " achados=" + ranked.count().toStr() + " resultados=" + out.count().toStr() + " offsets_errados=" + ToText(st.misses)
    data = { outdated: false, total: out.count() }
    if kind = "series" then
        data.series = out
    else
        data.items = out
    end if
    print "[DeltaTV][TRACE] XtMemSearchFast: SAIDA ranked=" + ranked.count().toStr() + " resultados=" + out.count().toStr()
    return { ok: true, status: 200, data: data, message: "" }
end function

' le UMA linha de uma categoria (offset/tamanho em bytes) sem carregar o arquivo inteiro
function XtMemReadLine(kind as String, gid as String, off as Integer, ln as Integer) as String
    if ln <= 0 then return ""
    ba = CreateObject("roByteArray")
    if not ba.ReadFile(XtMemCatPath(kind, gid), off, ln) then return ""
    return ba.ToAsciiString()
end function

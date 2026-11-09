 ' ============================================================
' TMDB v3 - somente metadados, nunca URLs Xtream ou credenciais do provedor.
' Todas as chamadas HTTP rodam numa Task (fora da render thread).
' ============================================================
sub init()
    m.top.functionName = "fetchTmdb"
end sub

sub fetchTmdb()
    req = m.top.request
    result = { ok: false, reqId: 0, itemId: "", operation: "", message: "", details: invalid }
    if type(req) <> "roAssociativeArray" then
        m.top.result = result
        return
    end if
    result.reqId = req.reqId
    result.itemId = ToText(req.itemId)
    result.operation = ToText(req.operation)
    key = DeltaTmdbCredential()
    if key = "" then
        result.message = "Chave de API não configurada."
        m.top.result = result
        return
    end if
    if req.operation = "check" then
        reply = TmdbGet("configuration", key, "")
        result.ok = (reply.status = 200 and type(reply.data) = "roAssociativeArray")
        if not result.ok then result.message = TmdbMessage(reply)
        m.top.result = result
        return
    end if
    if req.operation <> "details" then
        result.message = "Operação desconhecida."
        m.top.result = result
        return
    end if

    queryTitle = TmdbCleanTitle(ToText(req.title))
    kind = "movie"
    if req.kind = "series" then kind = "tv"
    if queryTitle = "" then
        result.message = "Título vazio."
        m.top.result = result
        return
    end if
    givenYear = TmdbYear(ToText(req.year))
    if givenYear = "" then givenYear = TmdbYear(ToText(req.title))
    search = TmdbGet("search/" + kind, key, "&language=pt-BR&include_adult=false&page=1&query=" + UrlEscape(queryTitle))
    if search.status <> 200 or type(search.data) <> "roAssociativeArray" then
        result.message = TmdbMessage(search)
        m.top.result = result
        return
    end if
    if type(search.data.results) <> "roArray" then
        result.message = "Resposta de busca inválida."
        m.top.result = result
        return
    end if
    match = invalid
    best = 0
    for each entry in search.data.results
        if type(entry) = "roAssociativeArray" then
            score = TmdbScore(queryTitle, givenYear, entry, kind)
            if score > best then
                best = score
                match = entry
            end if
        end if
    end for
    ' Não atribuir pôster/sinopse de um filme diferente.
    if match = invalid or best < 75 then
        result.message = "Nenhuma correspondência confiável."
        m.top.result = result
        return
    end if
    tmdbId = ToText(match.id)
    detail = TmdbGet(kind + "/" + tmdbId, key, "&language=pt-BR")
    details = match
    if detail.status = 200 and type(detail.data) = "roAssociativeArray" then details = detail.data
    synopsis = ToText(details.overview)
    if synopsis = "" then synopsis = ToText(match.overview)
    poster = ToText(details.poster_path)
    if poster = "" then poster = ToText(match.poster_path)
    backdrop = ToText(details.backdrop_path)
    if backdrop = "" then backdrop = ToText(match.backdrop_path)
    if Left(poster, 1) = "/" then
        poster = "https://image.tmdb.org/t/p/w500" + poster
    else
        poster = ""
    end if
    if Left(backdrop, 1) = "/" then
        backdrop = "https://image.tmdb.org/t/p/w780" + backdrop
    else
        backdrop = ""
    end if
    date = ToText(details.release_date)
    if kind = "tv" then date = ToText(details.first_air_date)
    year = TmdbYear(date)
    genres = ""
    if type(details.genres) = "roArray" then
        for each genre in details.genres
            if type(genre) = "roAssociativeArray" and ToText(genre.name) <> "" then
                if genres <> "" then genres = genres + ", "
                genres = genres + ToText(genre.name)
                if Len(genres) > 65 then exit for
            end if
        end for
    end if
    minutes = Int(Val(ToText(details.runtime)))
    if kind = "tv" and type(details.episode_run_time) = "roArray" then
        if details.episode_run_time.count() > 0 then minutes = Int(Val(ToText(details.episode_run_time[0])))
    end if
    duration = ""
    if minutes > 0 then duration = minutes.toStr() + " min"
    votes = Int(Val(ToText(details.vote_count)))
    rating = ""
    if votes > 0 then
        avg = Val(ToText(details.vote_average))
        if avg > 0 and avg <= 10 then
            tenths = Int(avg * 10 + 0.5)
            rating = Int(tenths / 10).toStr() + "." + (tenths mod 10).toStr()
        end if
    end if
    result.details = { title: queryTitle, description: synopsis, poster: poster, backdrop: backdrop, year: year, genre: genres, duration: duration, rating: rating }
    result.ok = true
    m.top.result = result
end sub

function TmdbGet(path as String, credential as String, query as String) as Object
    ' Chaves v3 sao 32 caracteres hexadecimais; tokens longos usam Bearer.
    bearer = ""
    authQuery = ""
    if Len(credential) = 32 and TmdbIsHex(credential) then
        authQuery = "?api_key=" + UrlEscape(credential)
    else
        bearer = credential
        authQuery = "?"
    end if
    if authQuery = "?" and Left(query, 1) = "&" then query = Mid(query, 2)
    url = "https://api.themoviedb.org/3/" + path + authQuery + query
    return HttpJson(url, "GET", "", bearer, 9000)
end function

function TmdbMessage(reply as Object) as String
    if reply.status = 401 or reply.status = 403 then return "Chave sem autorização (401/403)."
    if reply.status = 429 then return "Limite de consultas do TMDB atingido."
    if reply.status < 0 then return "Sem conexão ou tempo esgotado."
    return "HTTP " + ToText(reply.status)
end function

function TmdbIsHex(value as String) as Boolean
    for i = 1 to Len(value)
        if Instr(1, "0123456789abcdef", LCase(Mid(value, i, 1))) = 0 then return false
    end for
    return true
end function

function TmdbYear(value as String) as String
    if Len(value) < 4 then return ""
    for i = 1 to Len(value) - 3
        part = Mid(value, i, 4)
        if part >= "1900" and part <= "2099" and Val(part) >= 1900 and Val(part) <= 2099 then
            valid = true
            for j = 1 to 4
                ch = Mid(part, j, 1)
                if ch < "0" or ch > "9" then valid = false
            end for
            if valid then return part
        end if
    end for
    return ""
end function

function TmdbCleanTitle(original as String) as String
    cleanTitle = TrimText(original)
    ' Remove marcas de resolução e idioma comuns em nomes de listas IPTV.
    quality = ["[4K]", "[FHD]", "[HD]", "[SD]", "[UHD]", "[DUB]", "[LEG]", "4K", "1080P", "720P", "DUBLADO", "LEGENDADO", "BLURAY", "WEB-DL", ".MKV", ".MP4"]
    for each q in quality
        cleanTitle = cleanTitle.Replace(q, "")
        cleanTitle = cleanTitle.Replace(LCase(q), "")
    end for
    y = TmdbYear(cleanTitle)
    if y <> "" then
        cleanTitle = cleanTitle.Replace("(" + y + ")", "")
        cleanTitle = cleanTitle.Replace("[" + y + "]", "")
        cleanTitle = cleanTitle.Replace(" " + y, "")
    end if
    cleanTitle = TrimText(cleanTitle)
    while Len(cleanTitle) > 0 and (Left(cleanTitle, 1) = "-" or Left(cleanTitle, 1) = ":")
        cleanTitle = TrimText(Mid(cleanTitle, 2))
    end while
    while Len(cleanTitle) > 0 and (Right(cleanTitle, 1) = "-" or Right(cleanTitle, 1) = ":")
        cleanTitle = TrimText(Left(cleanTitle, Len(cleanTitle) - 1))
    end while
    return cleanTitle
end function

function TmdbCanonical(value as String) as String
    result = LCase(TrimText(value))
    for each c in [" ", ".", ",", ":", "!", "?", "'", Chr(34), "-", "_", "(", ")", "[", "]", "/", "&"]
        result = result.Replace(c, "")
    end for
    return result
end function

function TmdbScore(queryTitle as String, year as String, entry as Object, kind as String) as Integer
    query = TmdbCanonical(queryTitle)
    if query = "" then return 0
    name1 = ToText(entry.title)
    name2 = ToText(entry.original_title)
    release = ToText(entry.release_date)
    if kind = "tv" then
        name1 = ToText(entry.name)
        name2 = ToText(entry.original_name)
        release = ToText(entry.first_air_date)
    end if
    first = TmdbCanonical(name1)
    second = TmdbCanonical(name2)
    score = 0
    if first = query or second = query then
        score = 100
    else if (Len(query) > 5 and (Instr(1, first, query) = 1 or Instr(1, second, query) = 1)) then
        score = 77
    else if Len(first) > 5 and Instr(1, query, first) = 1 then
        score = 76
    else if Len(second) > 5 and Instr(1, query, second) = 1 then
        score = 76
    end if
    if year <> "" then
        filmYear = TmdbYear(release)
        if year = filmYear then
            score = score + 12
        else if filmYear <> "" then
            diff = Abs(Val(year) - Val(filmYear))
            if diff > 1 then score = score - 40
        end if
    end if
    return score
end function

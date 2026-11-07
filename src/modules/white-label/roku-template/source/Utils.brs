' ============================================================
' Delta TV - utilitarios compartilhados
' ============================================================

' true quando o canal ja usa pct% (ou mais) do limite de memoria. Sem o monitor/metodo (firmware antigo): false.
function MemTight(pct = 85 as Integer) as Boolean
    mon = CreateObject("roAppMemoryMonitor")
    if mon = invalid then return false
    if FindMemberFunction(mon, "GetMemoryLimitPercent") = invalid then return false
    return (mon.GetMemoryLimitPercent() >= pct)
end function

function WLAppearance() as Dynamic
    raw = RegRead("wl_appearance_v1")
    if raw = "" then return DeltaWhiteLabelEmbeddedAppearance()
    if Len(raw) > 6500 then return invalid
    conf = ParseJson(raw)
    if type(conf) <> "roAssociativeArray" then return invalid
    return conf
end function


' Per-screen labels, compatible with themes saved before screen customization existed.
function WLScreen(screen as String) as Dynamic
    theme = WLAppearance()
    if theme = invalid then return invalid
    if type(theme.screens) <> "roAssociativeArray" then return invalid
    item = theme.screens[screen]
    if type(item) <> "roAssociativeArray" then return invalid
    return item
end function

function WLColor(value as Dynamic, fallback as String) as String
    if type(value) <> "roString" and type(value) <> "String" then return fallback
    if Len(value) <> 7 or Left(value, 1) <> "#" then return fallback
    pat = CreateObject("roRegex", "^#[a-fA-F0-9]{6}$", "")
    if not pat.IsMatch(value) then return fallback
    return "0x" + Mid(value, 2) + "FF"
end function

function WLImageUri(value as Dynamic) as String
    if type(value) <> "roString" and type(value) <> "String" then return ""
    if Len(value) > 500 then return ""
    if LCase(Left(value, 8)) <> "https://" then return ""
    if Instr(1, value, "@") > 0 then return ""
    return value
end function

function Theme() as Object
    t = {
        bg: "0x090B14FF", panel: "0x101321FF", line: "0x1E2038FF", card: "0x141830FF",
        accent: "0x6B47E6FF", accentSoft: "0x3B2F7AFF", accentLight: "0xB9A6FFFF",
        text: "0xFFFFFFFF", textDim: "0xC3C7D8FF", textMute: "0x7F879FFF"
    }
    config = WLAppearance()
    if config = invalid then return t
    t.bg = WLColor(config.backgroundColor, t.bg)
    t.panel = WLColor(config.panelColor, t.panel)
    t.card = t.panel
    t.accent = WLColor(config.primaryColor, t.accent)
    t.accentSoft = t.accent
    t.accentLight = t.accent
    t.text = WLColor(config.textColor, t.text)
    ' Keep secondary text readable with arbitrary backgrounds.
    t.textDim = t.text
    t.textMute = t.text
    return t
end function

' ---------- fontes (com cache por componente) ----------
function GetFont(size as Integer, bold as Boolean) as Object
    if m.fontCache = invalid then m.fontCache = {}
    key = size.toStr()
    if bold then key = key + "b"
    f = m.fontCache[key]
    if f = invalid then
        f = CreateObject("roSGNode", "Font")
        if bold then
            f.uri = "font:BoldSystemFontFile"
        else
            f.uri = "font:SystemFontFile"
        end if
        f.size = size
        m.fontCache[key] = f
    end if
    return f
end function

' Aplica fonte + cor em um Label
sub Txt(node as Object, size as Integer, bold as Boolean, color as String)
    if node = invalid then return
    node.font = GetFont(size, bold)
    node.color = color
end sub

' ---------- registro (armazenamento persistente) ----------
function RegRead(key as String) as String
    sec = CreateObject("roRegistrySection", "DeltaTV")
    if sec.Exists(key) then return sec.Read(key)
    return ""
end function

sub RegWrite(key as String, value as String)
    sec = CreateObject("roRegistrySection", "DeltaTV")
    sec.Write(key, value)
    sec.Flush()
end sub

sub RegDelete(key as String)
    sec = CreateObject("roRegistrySection", "DeltaTV")
    if sec.Exists(key) then sec.Delete(key)
    sec.Flush()
end sub


' ---------- progresso de filmes e episodios (por conteudo, local ao aparelho) ----------
' Nunca usa URLs para identificadores: podem conter usuario/senha de provedores.
function VodBookmarkKey(mediaItem as Dynamic) as String
    if type(mediaItem) <> "roAssociativeArray" then return ""
    if mediaItem.live <> invalid then
        if mediaItem.live = true then return ""
    end if
    mediaId = ToText(mediaItem.id)
    if mediaId = "" or Len(mediaId) > 120 then return ""
    return "vod_" + mediaId
end function

function VodReadPosition(mediaItem as Dynamic) as Float
    bookmarkId = VodBookmarkKey(mediaItem)
    if bookmarkId = "" then return 0.0
    savedValue = RegRead(bookmarkId)
    if savedValue = "" then return 0.0
    savedSeconds = Val(savedValue)
    if savedSeconds < 10 then return 0.0
    return savedSeconds
end function

sub VodClearPosition(mediaItem as Dynamic)
    bookmarkId = VodBookmarkKey(mediaItem)
    if bookmarkId <> "" then RegDelete(bookmarkId)
end sub

' ---------- smart bookmarks de series ----------
' Usa o identificador estavel da serie; nunca grava URL ou credenciais no registro.
function VodSeriesRegistryKey(seriesRef as String) as String
    if seriesRef = "" or Len(seriesRef) > 110 then return ""
    ' Isola historicos de parcerias diferentes com o mesmo seriesId Xtream.
    if Left(seriesRef, 13) <> "deltatv-demo-" then
        activeList = RegRead("active_list")
        if activeList <> "" then seriesRef = activeList + ":" + seriesRef
    end if
    if Len(seriesRef) > 180 then return ""
    return "smart_" + seriesRef
end function

function VodReadSeriesState(seriesRef as String) as Object
    k = VodSeriesRegistryKey(seriesRef)
    if k = "" then return invalid
    raw = RegRead(k)
    if raw = "" then return invalid
    state = ParseJson(raw)
    if type(state) <> "roAssociativeArray" then return invalid
    if ToText(state.episodeId) = "" then return invalid
    return state
end function

sub VodWriteSeriesState(mediaItem as Dynamic, completed as Boolean, position = 0.0 as Float)
    if type(mediaItem) <> "roAssociativeArray" then return
    seriesRef = ToText(mediaItem.seriesRef)
    episodeId = ToText(mediaItem.seriesEpisodeId)
    k = VodSeriesRegistryKey(seriesRef)
    if k = "" or episodeId = "" then return
    RegWrite(k, FormatJson({
        episodeId: episodeId,
        season: Int(Val(ToText(mediaItem.seriesSeason))),
        number: Int(Val(ToText(mediaItem.seriesEpisodeNumber))),
        completed: completed,
        position: position
    }))
end sub

' ---------- favoritos ----------
function FavList() as Object
    raw = RegRead("favorites")
    if raw = "" then return []
    arr = ParseJson(raw)
    if arr = invalid then return []
    if type(arr) <> "roArray" then return []
    return arr
end function

function FavSet() as Object
    set = {}
    for each id in FavList()
        set[id] = true
    end for
    return set
end function

function FavIsFav(id as String) as Boolean
    for each x in FavList()
        if x = id then return true
    end for
    return false
end function

' Alterna e devolve o novo estado (true = favoritado)
function FavToggle(id as String) as Boolean
    list = FavList()
    novo = []
    found = false
    for each x in list
        if x = id then
            found = true
        else
            novo.push(x)
        end if
    end for
    if not found then novo.push(id)
    sec = CreateObject("roRegistrySection", "DeltaTV")
    saved = sec.Write("favorites", FormatJson(novo))
    if saved then saved = sec.Flush()
    if not saved then
        print "[Favoritos] falha ao gravar no registro"
        return found
    end if
    return FavIsFav(id)
end function

' ---------- texto ----------
function ToText(v as Dynamic) as String
    if v = invalid then return ""
    if GetInterface(v, "ifString") <> invalid then return v
    if GetInterface(v, "ifToStr") <> invalid then return v.toStr()
    return ""
end function

function TrimText(value as String) as String
    first = 1
    last = Len(value)
    while first <= last
        charCode = Asc(Mid(value, first, 1))
        if charCode <> 32 and charCode <> 9 and charCode <> 10 and charCode <> 13 then exit while
        first = first + 1
    end while
    while last >= first
        charCode = Asc(Mid(value, last, 1))
        if charCode <> 32 and charCode <> 9 and charCode <> 10 and charCode <> 13 then exit while
        last = last - 1
    end while
    if last < first then return ""
    return Mid(value, first, last - first + 1)
end function

function IsHttpUrl(url as String) as Boolean
    if Left(LCase(url), 7) = "http://" then
        remainder = Mid(url, 8)
    else if Left(LCase(url), 8) = "https://" then
        remainder = Mid(url, 9)
    else
        return false
    end if
    if remainder = "" then return false

    authorityEnd = Len(remainder) + 1
    for each delimiter in ["/", "?", "#"]
        position = Instr(1, remainder, delimiter)
        if position > 0 and position < authorityEnd then authorityEnd = position
    end for
    if authorityEnd = 1 then return false

    for i = 1 to Len(url)
        charCode = Asc(Mid(url, i, 1))
        if charCode <= 32 or charCode = 127 then return false
    end for
    return true
end function

function SafeErrorText(message as String, fallback as String, sensitiveValues as Object) as String
    if message = "" then return fallback
    lowerMessage = LCase(message)
    for each value in sensitiveValues
        sensitiveText = ToText(value)
        if sensitiveText <> "" and Instr(1, lowerMessage, LCase(sensitiveText)) > 0 then return fallback
    end for
    return message
end function

function Pad2(n as Integer) as String
    s = n.toStr()
    if Len(s) < 2 then s = "0" + s
    return s
end function

function ClockText() as String
    dt = CreateObject("roDateTime")
    dt.ToLocalTime()
    return Pad2(dt.GetHours()) + ":" + Pad2(dt.GetMinutes())
end function

' JSON com as chaves exatamente como escritas. Em BrightScript, {refreshToken: x} vira "refreshtoken" no FormatJson
' (chaves de AA nao preservam a caixa), e o servidor exige camelCase. pairs = [["chave", valor], ...]
function DeltaJson(pairs as Object) as String
    out = ""
    for each p in pairs
        if out <> "" then out = out + ","
        out = out + FormatJson(p[0]) + ":" + FormatJson(p[1])
    end for
    return "{" + out + "}"
end function

function GuessStreamFormat(url as String) as String
    u = LCase(url)
    q = Instr(1, u, "?")
    if q > 0 then u = Left(u, q - 1) ' ignora ?t=<token>
    if Instr(1, u, ".mpd") > 0 then return "dash"
    if Instr(1, u, ".mp4") > 0 then return "mp4"
    if Instr(1, u, ".m4v") > 0 then return "mp4"
    if Instr(1, u, ".mkv") > 0 then return "mkv"
    if Right(u, 5) = ".m3u8" then return "hls"
    if Right(u, 3) = ".ts" then return "ts" ' fluxo MPEG-TS direto (canais ao vivo do provedor)
    return "hls"
end function

' ---------- conteudo (ContentNode) ----------
function BuildItemNode(it as Object, favs as Object) as Object
    n = CreateObject("roSGNode", "ContentNode")
    n.title = it.title
    n.description = it.description
    n.HDPosterUrl = it.poster
    n.url = it.url
    n.streamFormat = it.streamFormat
    isFav = false
    if favs <> invalid then
        if favs[it.id] = true then isFav = true
    end if
    n.addFields({
        itemId: it.id,
        kind: it.kind,
        playPath: it.playPath,
        playToken: it.playToken,
        accent: it.accent,
        backdropUrl: it.backdrop,
        yearText: it.yearText,
        genreText: it.genreText,
        durationText: it.durationText,
        ageRating: it.ageRating,
        chNumber: it.number,
        category: it.category,
        nowTitle: it.nowTitle,
        nextTitle: it.nextTitle,
        isFav: isFav
    })
    return n
end function

' root -> [ linha(titulo) -> itens ]  (usado por RowList)
function BuildRowContent(items as Object, favs as Object, rowTitle as String) as Object
    root = CreateObject("roSGNode", "ContentNode")
    row = CreateObject("roSGNode", "ContentNode")
    row.title = rowTitle
    for each it in items
        row.appendChild(BuildItemNode(it, favs))
    end for
    root.appendChild(row)
    return root
end function

' root -> itens  (usado por MarkupList / MarkupGrid)
function BuildFlatContent(items as Object, favs as Object) as Object
    root = CreateObject("roSGNode", "ContentNode")
    for each it in items
        root.appendChild(BuildItemNode(it, favs))
    end for
    return root
end function

' Lista simples de textos -> ContentNode (com campo isSel)
function BuildTextContent(titles as Object) as Object
    root = CreateObject("roSGNode", "ContentNode")
    for each t in titles
        n = CreateObject("roSGNode", "ContentNode")
        n.title = t
        n.addFields({ isSel: false })
        root.appendChild(n)
    end for
    return root
end function

' Marca qual item de uma lista de textos esta "selecionado"
sub MarkSelected(content as Object, idx as Integer)
    if content = invalid then return
    for i = 0 to content.getChildCount() - 1
        content.getChild(i).isSel = (i = idx)
    end for
end sub

' RowList de uma unica linha (altura = altura do item, sem ambiguidade)
function MakeSingleRowList(rowW as Integer, itemW as Integer, itemH as Integer, gap as Integer, xOff as Integer) as Object
    rl = CreateObject("roSGNode", "RowList")
    rl.itemComponentName = "PosterItem"
    rl.numRows = 1
    rl.itemSize = [rowW, itemH]
    rl.rowHeights = [itemH]
    rl.rowItemSize = [[itemW, itemH]]
    rl.rowItemSpacing = [[gap, 0]]
    rl.focusXOffset = [xOff]
    rl.rowLabelOffset = [[xOff, 0]]
    rl.showRowLabel = [false]
    rl.showRowCounter = [false]
    rl.rowFocusAnimationStyle = "floatingFocus"
    rl.drawFocusFeedback = false
    rl.focusBitmapUri = "pkg:/images/blank.png"
    return rl
end function


' Nome da pasta sem o prefixo do tipo: "Canais | Globo" -> "Globo"
function FolderName(group as String) as String
    g = group
    p = Instr(1, g, "|")
    if p = 0 then p = Instr(1, g, ":")
    if p > 0 and p <= 12 then
        head = LCase(Left(g, p - 1)).Trim()
        if head = "canais" or head = "canal" or head = "filmes" or head = "filme" or head = "series" or head = "séries" or head = "serie" or head = "live" or head = "movies" then
            g = Mid(g, p + 1)
        end if
    end if
    g = g.Trim()
    if g = "" then g = "Outros"
    return g
end function

' id de favorito salvo no modo paginado = "me-<id do item>" (lista unica Xtream).
' Ids antigos/posicionais (p12) legados nao sao resolviveis aqui e retornam invalid.
function LazyParseFavId(fid as String) as Object
    srcId = ""
    rawId = ""
    if Left(fid, 3) = "me-" then
        srcId = "me"
        rawId = Mid(fid, 4)
    else
        return invalid
    end if
    ' ids Xtream: "l<canal>_<categoria>" (ao vivo) ou "m<filme>_<categoria>"; favoritos antigos (UUID) nao resolvem mais
    if rawId = "" then return invalid
    head = Left(rawId, 1)
    if head <> "l" and head <> "m" then
        for i = 1 to Len(rawId)
            ch = Mid(rawId, i, 1)
            if ch < "0" or ch > "9" then return invalid
        end for
        return { sourceId: srcId, itemId: "s" + rawId, kind: "series" }
    end if
    if Len(rawId) < 3 then return invalid
    if Instr(1, rawId, "_") < 3 then return invalid
    return { sourceId: srcId, itemId: rawId, kind: head }
end function

' Percent-encoding em BrightScript puro (roUrlTransfer.Escape nao pode ser usado na thread de render).
function UrlEscape(s as String) as String
    hex = "0123456789ABCDEF"
    out = ""
    for i = 1 to Len(s)
        ch = Mid(s, i, 1)
        c = Asc(ch)
        if (c >= 48 and c <= 57) or (c >= 65 and c <= 90) or (c >= 97 and c <= 122) or c = 45 or c = 46 or c = 95 or c = 126 then
            out = out + ch
        else if c < 128 then
            out = out + "%" + Mid(hex, (c \ 16) + 1, 1) + Mid(hex, (c mod 16) + 1, 1)
        else
            ' UTF-8 (nao ocorre em tokens; mantido por seguranca)
            bytes = []
            if c < 2048 then
                bytes = [192 + (c \ 64), 128 + (c mod 64)]
            else if c >= 65536 then
                bytes = [240 + (c \ 262144), 128 + ((c \ 4096) mod 64), 128 + ((c \ 64) mod 64), 128 + (c mod 64)]
            else
                bytes = [224 + (c \ 4096), 128 + ((c \ 64) mod 64), 128 + (c mod 64)]
            end if
            for each b in bytes
                out = out + "%" + Mid(hex, (b \ 16) + 1, 1) + Mid(hex, (b mod 16) + 1, 1)
            end for
        end if
    end for
    return out
end function

' User-Agent do provedor (o mesmo usado nas consultas ao painel) para a reproducao direta dos streams.
function PlayUserAgent() as String
    ua = RegRead("xt_ua")
    if ua = "" then ua = "Mozilla/5.0"
    return ua
end function

' Passa somente os metadados opcionais de cenas, sem copiar capas como falsas miniaturas.
function CopyTrickplayMetadata(sourceItem as Object, targetItem as Object) as Object
    if type(sourceItem) <> "roAssociativeArray" then return targetItem
    if type(targetItem) <> "roAssociativeArray" then return targetItem
    for each keyName in ["HDBifUrl", "SDBifUrl", "FHDBifUrl", "thumbnailUrlTemplate", "thumbnailInterval"]
        v = sourceItem.LookupCI(keyName)
        if v <> invalid then targetItem[keyName] = v
    end for
    return targetItem
end function

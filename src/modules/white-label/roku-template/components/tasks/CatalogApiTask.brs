' ============================================================
' Uma consulta de catalogo (pastas, canais, filmes, series, temporadas, episodios, item).
' Uma Task por requisicao: a tela descarta respostas antigas comparando reqId.
'
' O formato do pedido (request.path / request.query) e o da antiga API /client/catalog/*, entao as telas
' continuam iguais. A resposta agora vem direto do painel Xtream do provedor (source/Xtream.brs): o servidor
' Delta so entrega a conexao (usuario/senha/painel) e valida a licenca.
' ============================================================
sub init()
    m.top.functionName = "runRequest"
end sub

sub runRequest()
    req = m.top.request
    out = {
        ok: false, status: -1, code: "", message: "", data: invalid,
        reqId: req.reqId, op: req.op, clearAuth: false
    }

    q = req.query
    if q = invalid then q = {}
    if type(q) <> "roAssociativeArray" then q = {}
    path = ToText(req.path)

    ' 1) memoria local (pre-carregada ao abrir o app): responde sem rede e sem consultar o servidor.
    '    invalid = ainda nao carregada, ou rota que precisa do provedor (temporadas/episodios).
    if ToText(q.sourceId) = "" or ToText(q.sourceId) = "me" then
        fromMem = XtMemQuery(path, q)
        if fromMem <> invalid then
            out.status = fromMem.status
            out.message = fromMem.message
            out.data = fromMem.data
            out.ok = (fromMem.ok = true and fromMem.data <> invalid)
            m.top.result = out
            return
        end if
    end if

    ' 2) provedor (como antes)
    conn = XtGetConfig()
    if not conn.ok then
        out.message = conn.message
        out.clearAuth = conn.clearAuth
        m.top.result = out
        return
    end if
    cfg = conn.cfg

    r = invalid
    if ToText(q.sourceId) <> "" and ToText(q.sourceId) <> "me" then
        ' favoritos antigos apontam para listas que nao existem mais
        r = { ok: false, status: 404, data: invalid, message: "Lista não encontrada." }
    else
        r = Dispatch(cfg, path, q)
    end if

    out.status = r.status
    out.message = r.message
    out.data = r.data
    out.ok = (r.ok = true and r.data <> invalid)
    if not out.ok then
        if out.message = "" then out.message = "Não foi possível carregar os dados do servidor."
        ' a conexao em cache pode estar velha (lista trocada pelo revendedor): pede de novo na proxima
        if r.status <> 404 then XtForgetConfig()
    end if
    m.top.result = out
end sub

function Dispatch(cfg as Object, path as String, q as Object) as Object
    cursor = ToText(q.cursor)
    pageSize = ToText(q.pageSize)

    if path = "groups" then
        return XtGroups(cfg, ToText(q.kind))
    else if path = "items" then
        return XtItems(cfg, ToText(q.kind), ToText(q.groupId), cursor, pageSize)
    else if path = "search" then
        ' sem groupId = pesquisa no catalogo inteiro (rota que lista todos os filmes/series de uma vez)
        if ToText(q.groupId) = "" then return XtSearchAll(cfg, ToText(q.kind), ToText(q.term), 300)
        return XtSearch(cfg, ToText(q.kind), ToText(q.groupId), ToText(q.term))
    else if path = "series" then
        return XtSeriesList(cfg, ToText(q.groupId), cursor, pageSize)
    else if Left(path, 6) = "items/" then
        return XtItemById(cfg, Mid(path, 7))
    else if Left(path, 7) = "series/" then
        rest = Mid(path, 8)
        cut = Instr(1, rest, "/")
        if cut > 1 then
            seriesId = Left(rest, cut - 1)
            what = Mid(rest, cut + 1)
            if what = "seasons" then return XtSeasons(cfg, seriesId)
            if what = "episodes" then return XtEpisodes(cfg, seriesId, ToText(q.season), cursor, pageSize)
        end if
    end if
    return { ok: false, status: 404, data: invalid, message: "Rota não encontrada." }
end function

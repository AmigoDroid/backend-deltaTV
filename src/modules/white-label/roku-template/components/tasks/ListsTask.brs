' Sincroniza as listas deste aparelho com o servidor.
' Um MAC pode ter VARIOS parceiros: GET /client/lists mostra todas as listas vivas do aparelho e
' POST /client/lists/<id>/session emite a sessao de uma lista nova (ex.: parceiro adicionado pelo painel).
' NAO renova tokens aqui (renovar em paralelo com outras tarefas giraria o refresh token): se o token estiver
' vencido, devolve needsRefresh e a verificacao de estado (que renova) tenta de novo na proxima rodada.
'
' params: { accessToken, knownIds: [activationId], ignoredIds: [activationId], slots: vagas livres }
' result: { ok, needsRefresh, message, serverIds: [activationId], lists: [{ activationId, kind, status, listName,
'           allowed, configured, accessToken, refreshToken }] }
sub init()
    m.top.functionName = "syncLists"
end sub

sub syncLists()
    p = m.top.params
    res = { ok: false, needsRefresh: false, message: "", serverIds: [], lists: [] }
    accessToken = ToText(p.accessToken)
    if not DeltaServerConfigured() or accessToken = "" then
        m.top.result = res
        return
    end if
    identity = DeltaGetIdentity()

    known = {}
    if p.knownIds <> invalid and type(p.knownIds) = "roArray" then
        for each id in p.knownIds
            known[ToText(id)] = true
        end for
    end if
    ignored = {}
    if p.ignoredIds <> invalid and type(p.ignoredIds) = "roArray" then
        for each id in p.ignoredIds
            ignored[ToText(id)] = true
        end for
    end if
    slots = 0
    if p.slots <> invalid then slots = Int(p.slots)

    req = ListsHttp(DeltaListsUrl(), "GET", "", accessToken)
    if req.status = 401 then
        res.needsRefresh = true
        m.top.result = res
        return
    end if
    if req.status <> 200 or req.data = invalid or type(req.data) <> "roAssociativeArray" then
        res.message = req.message
        m.top.result = res
        return
    end if
    arr = req.data.lists
    if arr = invalid or type(arr) <> "roArray" then
        res.message = "Resposta de listas inválida."
        m.top.result = res
        return
    end if

    for each l in arr
        if type(l) = "roAssociativeArray" then
            item = {
                activationId: ToText(l.activationId),
                kind: ToText(l.kind),
                status: ToText(l.status),
                listName: ToText(l.listName),
                allowed: (l.allowed = true),
                configured: (l.configured = true),
                accessToken: "",
                refreshToken: ""
            }
            if item.activationId <> "" then
                res.serverIds.push(item.activationId)
                isNew = not known.doesExist(item.activationId)
                skip = ignored.doesExist(item.activationId)
                if isNew and not skip and item.allowed and item.configured and slots > 0 then
                    body = DeltaJson([["installationId", identity.installationId]])
                    sess = ListsHttp(DeltaListSessionUrl(item.activationId), "POST", body, accessToken)
                    if sess.status = 200 and sess.data <> invalid and type(sess.data) = "roAssociativeArray" then
                        t = sess.data.tokens
                        if t <> invalid and type(t) = "roAssociativeArray" then
                            item.accessToken = ToText(t.accessToken)
                            item.refreshToken = ToText(t.refreshToken)
                            if item.accessToken <> "" and item.refreshToken <> "" then slots = slots - 1
                        end if
                    end if
                end if
                res.lists.push(item)
            end if
        end if
    end for
    res.ok = true
    m.top.result = res
end sub

function ListsHttp(url as String, method as String, body as String, accessToken as String) as Object
    result = { status: -1, data: invalid, message: "" }
    transfer = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    transfer.SetMessagePort(port)
    transfer.SetUrl(url)
    transfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    transfer.AddHeader("Accept", "application/json")
    if method = "POST" then transfer.AddHeader("Content-Type", "application/json")
    if accessToken <> "" then transfer.AddHeader("Authorization", "Bearer " + accessToken)
    transfer.RetainBodyOnError(true)
    transfer.EnableEncodings(true)

    started = false
    if method = "POST" then
        started = transfer.AsyncPostFromString(body)
    else
        started = transfer.AsyncGetToString()
    end if
    if not started then
        result.message = "Não foi possível iniciar a requisição ao servidor."
        return result
    end if
    event = wait(15000, port)
    if type(event) <> "roUrlEvent" then
        transfer.AsyncCancel()
        result.message = "Tempo esgotado. Verifique a conexão com o servidor."
        return result
    end if
    result.status = event.GetResponseCode()
    result.data = ParseJson(event.GetString())
    if result.data <> invalid and type(result.data) = "roAssociativeArray" then
        result.message = ToText(result.data.message)
    end if
    if result.status < 0 and result.message = "" then result.message = "Sem conexão com o servidor."
    return result
end function

' ============================================================
' Delta TV - gerenciamento de listas (persistente)
'
' Cada lista = uma sessao do servidor Delta (tokens + dados da ativacao). O aparelho usa UMA lista por vez ("ativa"):
' os tokens dela ficam nas chaves de sempre do registro (auth_token / refresh_token / list_name / ...), e todas as
' listas ficam guardadas em "lists" (JSON) para trocar entre elas sem reconectar.
'
'   lists        [{ id, name, kind, accessToken, refreshToken, activationId, cfgVer, state, checkedAt }]
'   active_list  id da lista ativa
'   adding_prev  id da lista que estava ativa quando se abriu "Adicionar lista" (volta para ela se o usuario cancelar)
'
' Requer: Utils.brs (RegRead/RegWrite/RegDelete/ToText) e Xtream.brs (XtClearCatalogCache).
' ============================================================

function ListsMax() as Integer
    return 8
end function

function ListsLoad() as Object
    raw = RegRead("lists")
    if raw = "" then return []
    a = ParseJson(raw)
    if a = invalid then return []
    if type(a) <> "roArray" then return []
    return a
end function

sub ListsSave(a as Object)
    RegWrite("lists", FormatJson(a))
end sub

function ListsFind(a as Object, id as String) as Integer
    if id = "" then return -1
    for i = 0 to a.count() - 1
        if ToText(a[i].id) = id then return i
    end for
    return -1
end function

function ListsFindByActivation(a as Object, activationId as String) as Integer
    if activationId = "" then return -1
    for i = 0 to a.count() - 1
        if ToText(a[i].activationId) = activationId then return i
    end for
    return -1
end function

function ListsHasSession() as Boolean
    return RegRead("auth_token") <> "" or RegRead("refresh_token") <> ""
end function

' Garante que a sessao atual (do registro) esta na lista de listas, com os tokens mais recentes (eles giram).
sub ListsSyncActive()
    if not ListsHasSession() then return
    lists = ListsLoad()
    actId = RegRead("activation_id")
    ' lista que o usuario excluiu daqui mas conectou de novo: volta a valer
    if actId <> "" then ListsIgnoreRemove(actId)
    idx = ListsFind(lists, RegRead("active_list"))
    ' ativacao diferente da guardada = e outra lista (ex.: conectou uma nova depois de a anterior cair)
    if idx >= 0 and actId <> "" and ToText(lists[idx].activationId) <> "" and ToText(lists[idx].activationId) <> actId then idx = -1
    if idx < 0 then idx = ListsFindByActivation(lists, actId)
    if idx < 0 then
        id = actId
        if id = "" then id = "l" + CreateObject("roDateTime").AsSeconds().toStr()
        if ListsFind(lists, id) >= 0 then id = id + "x" + lists.count().toStr()
        lists.push({ id: id, name: "", kind: "", accessToken: "", refreshToken: "", activationId: "", cfgVer: "", state: "", checkedAt: 0 })
        idx = lists.count() - 1
    end if
    e = lists[idx]
    e.accessToken = RegRead("auth_token")
    e.refreshToken = RegRead("refresh_token")
    if actId <> "" then e.activationId = actId
    nm = RegRead("list_name")
    if nm <> "" then e.name = nm
    if ToText(e.name) = "" then e.name = "Lista " + (idx + 1).toStr()
    k = RegRead("activation_kind")
    if k <> "" then e.kind = k
    v = RegRead("configuration_version")
    if v <> "" then e.cfgVer = v
    st = RegRead("configuration_status")
    if st <> "" then e.state = st
    lists[idx] = e
    RegWrite("active_list", ToText(e.id))
    ListsSave(lists)
end sub

' Apaga do registro tudo o que pertence a uma sessao (a lista continua guardada em "lists").
sub ListsClearActiveSession()
    for each k in ["auth_token", "refresh_token", "activation_id", "configuration_status", "configuration_version", "list_name", "license_pending_configuration", "xt_cfg", "registration_token", "registration_pairing_url", "registration_installation_id", "active_list"]
        RegDelete(k)
    end for
    XtClearCatalogCache()
end sub

' Ativa uma lista guardada: copia os tokens dela para o registro e descarta credenciais/catalogo em cache da anterior.
function ListsActivate(id as String) as Boolean
    ListsSyncActive() ' guarda os tokens mais recentes da que esta saindo
    lists = ListsLoad()
    idx = ListsFind(lists, id)
    if idx < 0 then return false
    e = lists[idx]
    ListsClearActiveSession()
    if ToText(e.accessToken) <> "" then RegWrite("auth_token", e.accessToken)
    if ToText(e.refreshToken) <> "" then RegWrite("refresh_token", e.refreshToken)
    if ToText(e.name) <> "" then RegWrite("list_name", e.name)
    if ToText(e.activationId) <> "" then RegWrite("activation_id", e.activationId)
    if ToText(e.kind) <> "" then RegWrite("activation_kind", e.kind)
    if ToText(e.state) <> "" then RegWrite("configuration_status", e.state)
    if ToText(e.cfgVer) <> "" then RegWrite("configuration_version", e.cfgVer)
    RegWrite("active_list", ToText(e.id))
    return true
end function

' Remove uma lista guardada. Se era a ativa, a sessao do aparelho tambem e encerrada (quem chama ativa outra, se houver).
' Retorna true se a removida era a ativa.
function ListsRemove(id as String) as Boolean
    ListsSyncActive()
    lists = ListsLoad()
    idx = ListsFind(lists, id)
    if idx < 0 then return false
    wasActive = (RegRead("active_list") = id)
    lists.delete(idx)
    ListsSave(lists)
    if wasActive then ListsClearActiveSession()
    return wasActive
end function

' Prepara "Adicionar lista": guarda a atual e deixa o aparelho sem sessao, para a tela de conexao (QR) funcionar do zero.
sub ListsPrepareAdd()
    ListsSyncActive()
    RegWrite("adding_prev", RegRead("active_list"))
    ListsClearActiveSession()
end sub

' Cancelou a adicao (ou o app foi reaberto no meio dela): volta para a lista anterior (ou a primeira guardada).
function ListsRestorePrev() as Boolean
    lists = ListsLoad()
    if lists.count() = 0 then
        RegDelete("adding_prev")
        return false
    end if
    prev = RegRead("adding_prev")
    RegDelete("adding_prev")
    if ListsFind(lists, prev) < 0 then prev = ToText(lists[0].id)
    return ListsActivate(prev)
end function

' Texto curto do estado de uma lista (para a tela).
function ListsStateText(state as String) as String
    if state = "configured_partner" or state = "configured_playlist" or state = "configured" then return "pronta"
    if state = "expired" then return "expirada"
    if state = "disabled" or state = "deactivated" then return "desativada"
    if state = "awaiting_configuration" then return "aguardando configuração"
    if state = "session_required" then return "sessão necessária"
    if state = "offline" then return "sem resposta do servidor"
    if state = "error" then return "serviço indisponível"
    return ""
end function

' ============================================================
' Listas do SERVIDOR: um MAC pode ter VARIOS parceiros (uma lista por parceiro + uma lista propria).
' Cada lista tem a sua propria sessao. O app guarda todas em "lists" e usa uma por vez.
'   lists_ignored  ids de ativacao que o usuario excluiu deste aparelho (a sincronizacao nao as traz de volta)
' ============================================================

function ListsIgnoredLoad() as Object
    raw = RegRead("lists_ignored")
    if raw = "" then return []
    a = ParseJson(raw)
    if a = invalid then return []
    if type(a) <> "roArray" then return []
    return a
end function

function ListsIsIgnored(activationId as String) as Boolean
    if activationId = "" then return false
    for each x in ListsIgnoredLoad()
        if ToText(x) = activationId then return true
    end for
    return false
end function

sub ListsIgnoreAdd(activationId as String)
    if activationId = "" then return
    if ListsIsIgnored(activationId) then return
    a = ListsIgnoredLoad()
    a.push(activationId)
    while a.count() > 40
        a.delete(0)
    end while
    RegWrite("lists_ignored", FormatJson(a))
end sub

sub ListsIgnoreRemove(activationId as String)
    if activationId = "" then return
    a = ListsIgnoredLoad()
    out = []
    changed = false
    for each x in a
        if ToText(x) = activationId then
            changed = true
        else
            out.push(x)
        end if
    end for
    if changed then RegWrite("lists_ignored", FormatJson(out))
end sub

' Exclusao pedida pelo usuario: remove daqui e nao deixa a sincronizacao trazer a lista de volta.
function ListsRemoveAndIgnore(id as String) as Boolean
    ListsSyncActive()
    lists = ListsLoad()
    idx = ListsFind(lists, id)
    actId = ""
    if idx >= 0 then actId = ToText(lists[idx].activationId)
    wasActive = ListsRemove(id)
    ListsIgnoreAdd(actId)
    return wasActive
end function

function ListsIsConfiguredState(st as String) as Boolean
    return st = "configured_partner" or st = "configured_playlist"
end function

' Estados em que a lista nao serve para uso agora (a troca automatica pula estas).
function ListsUnusableState(st as String) as Boolean
    return st = "expired" or st = "disabled" or st = "deactivated" or st = "session_required" or st = "awaiting_configuration" or st = "error"
end function

' Junta as listas devolvidas pelo servidor (poll do pareamento ou /lists) as guardadas.
' Cada item: { activationId, kind, status, listName, accessToken, refreshToken } (tokens podem vir vazios).
' Lista nova so entra se estiver configurada e tiver sessao; as ja guardadas so atualizam estado/nome/tokens.
function ListsMergeServer(serverLists as Dynamic) as Boolean
    if serverLists = invalid then return false
    if type(serverLists) <> "roArray" then return false
    lists = ListsLoad()
    active = RegRead("active_list")
    now = CreateObject("roDateTime").AsSeconds()
    changed = false
    activeEntry = invalid
    for each s in serverLists
        aid = ToText(s.activationId)
        if aid <> "" and not ListsIsIgnored(aid) then
            tokA = ToText(s.accessToken)
            tokR = ToText(s.refreshToken)
            st = ToText(s.status)
            nm = ToText(s.listName)
            idx = ListsFindByActivation(lists, aid)
            if idx < 0 then
                hasSession = (tokA <> "" or tokR <> "")
                if hasSession and ListsIsConfiguredState(st) and lists.count() < ListsMax() then
                    if nm = "" then nm = "Lista " + (lists.count() + 1).toStr()
                    lists.push({ id: aid, name: nm, kind: ToText(s.kind), accessToken: tokA, refreshToken: tokR, activationId: aid, cfgVer: "", state: st, checkedAt: now })
                    changed = true
                end if
            else
                e = lists[idx]
                if tokA <> "" then e.accessToken = tokA
                if tokR <> "" then e.refreshToken = tokR
                if st <> "" then e.state = st
                if nm <> "" then e.name = nm
                if ToText(s.kind) <> "" then e.kind = ToText(s.kind)
                lists[idx] = e
                changed = true
                if ToText(e.id) = active then activeEntry = e
            end if
        end if
    end for
    if changed then ListsSave(lists)
    ' a lista em uso tambem vive no registro: mantem os dois iguais
    if activeEntry <> invalid then
        if ToText(activeEntry.accessToken) <> "" then RegWrite("auth_token", activeEntry.accessToken)
        if ToText(activeEntry.refreshToken) <> "" then RegWrite("refresh_token", activeEntry.refreshToken)
        if ToText(activeEntry.name) <> "" then RegWrite("list_name", activeEntry.name)
        if ToText(activeEntry.state) <> "" then RegWrite("configuration_status", activeEntry.state)
    end if
    return changed
end function

' Remove as listas guardadas que o servidor nao tem mais (removidas no painel ou revogadas).
' liveIds = ids de ativacao vivos no servidor. Retorna { removed, activeRemoved }.
function ListsDropMissing(liveIds as Dynamic) as Object
    out = { removed: 0, activeRemoved: false }
    if liveIds = invalid then return out
    if type(liveIds) <> "roArray" then return out
    lists = ListsLoad()
    active = RegRead("active_list")
    keep = []
    for each e in lists
        aid = ToText(e.activationId)
        found = (aid = "")
        if not found then
            for each x in liveIds
                if ToText(x) = aid then
                    found = true
                    exit for
                end if
            end for
        end if
        if found then
            keep.push(e)
        else
            out.removed = out.removed + 1
            if ToText(e.id) = active then out.activeRemoved = true
        end if
    end for
    if out.removed > 0 then
        ListsSave(keep)
        if out.activeRemoved then ListsClearActiveSession()
    end if
    return out
end function

' Ativa a primeira lista guardada (diferente de excludeId) que tem sessao e nao esta bloqueada/expirada.
function ListsActivateNextUsable(excludeId as String) as Boolean
    lists = ListsLoad()
    for each e in lists
        hasSession = (ToText(e.accessToken) <> "" or ToText(e.refreshToken) <> "")
        if ToText(e.id) <> excludeId and hasSession and not ListsUnusableState(ToText(e.state)) then
            return ListsActivate(ToText(e.id))
        end if
    end for
    return false
end function

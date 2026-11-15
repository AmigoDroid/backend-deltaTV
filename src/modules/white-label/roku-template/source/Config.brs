' ============================================================
' Delta TV - configuracao do servidor
' >>> TROQUE pelos enderecos do SEU servidor <<<
' ============================================================

function DeltaServerOrigin() as String
    ' Use um host acessível pelo Roku; localhost aponta para o proprio aparelho.
    return "https://delta-tv.duckdns.org"
end function


' New white-label apps: set to their appKey when packaging a unique Roku channel.
' Leave blank for the legacy DeltaTV release (no visual overrides).
function DeltaWhiteLabelAppKey() as String
    return ""
end function

' The white-label theme service is separate from the legacy DeltaTV client API.
function DeltaWhiteLabelApiOrigin() as String
    return "https://api.deltatv.com.br"
end function

function DeltaServerConfigured() as Boolean
    return DeltaServerOrigin() <> "http://79.182.4.122" and Instr(1, DeltaServerOrigin(), "SEU-SERVIDOR") = 0
end function

function DeltaClientUrl(path as String) as String
    return DeltaServerOrigin() + "/api/v1/client" + path
end function

function DeltaActivationUrl(kind as String) as String
    return DeltaClientUrl("/activate/" + kind)
end function

function DeltaRefreshUrl() as String
    return DeltaClientUrl("/session/refresh")
end function

function DeltaResourcesUrl() as String
    return DeltaClientUrl("/resources")
end function

' ------------------------------------------------------------
' Catalogo em FLUXO PAGINADO (padrao).
'   true  = o app NUNCA baixa o catalogo inteiro: pede as pastas e depois uma pagina pequena por vez
'           (API /client/catalog/*, cursor). Cada resposta (~10-20 KB) e processada e descartada.
'   false = modo legado: baixa o JSON completo (~60 MB) e faz ParseJson na TV -> estoura a memoria.
'           So existe para depuracao com listas minusculas. NAO use em producao.
' ------------------------------------------------------------
function DeltaLazyCatalog() as Boolean
    return true
end function

function DeltaDeviceKeyUrl() as String
    return DeltaClientUrl("/device-key")
end function

' Conexao Xtream do aparelho (painel + usuario + senha do provedor). Exige sessao valida; o servidor so entrega
' os dados, quem consulta o painel e o proprio app (source/Xtream.brs).
function DeltaXtreamUrl() as String
    return DeltaClientUrl("/xtream")
end function

' ------------------------------------------------------------
' Site de cadastro (frontend). O QR da tela de conexao aponta para
'   <DeltaWebOrigin>/upload/playlist?mac=<MAC sem separadores>
' A pagina reconhece o parametro e ja preenche o campo do MAC.
' Use um host acessivel pelo CELULAR (nunca localhost) e mantenha o endereco curto: QR menor le melhor.
' ------------------------------------------------------------
function DeltaWebOrigin() as String
    return "https://frontend-player-deltatv.onrender.com"
end function

function DeltaUploadUrl(macCompact as String) as String
    return DeltaWebOrigin() + "/upload/playlist?mac=" + macCompact
end function

' Um MAC pode ter VARIAS listas (uma por parceiro). /lists mostra todas; /lists/<id>/session emite a sessao de uma delas.
function DeltaListsUrl() as String
    return DeltaClientUrl("/lists")
end function

function DeltaListSessionUrl(activationId as String) as String
    return DeltaClientUrl("/lists/" + activationId + "/session")
end function

' Versao exibida no app (menu lateral e Configuracoes > Sobre). O manifest guarda a versao numerica do Roku
' (major/minor/build); este e o texto mostrado ao usuario.
function DeltaAppVersion() as String
    return "v1.0.1"
end function

' ------------------------------------------------------------
' TMDB: token somente de LEITURA, fornecido pelo proprietario.
' ATENCAO: qualquer segredo incluso no canal Roku pode ser extraido.
' Em uma versao publica, prefira autenticar via backend do Delta TV.
' Nao registrar ou exibir a credencial na interface/logs.
' ------------------------------------------------------------
function DeltaTmdbCredential() as String
    ' Each white-label app needs its own server-side integration/permission.
    return ""
end function

' White-label builds are independently identified by their appKey.
function DeltaWhiteLabelMode() as Boolean
    return DeltaWhiteLabelAppKey() <> ""
end function

function DeltaWhiteLabelEmbeddedAppearance() as Dynamic
    return invalid ' Replaced at packaging with a published snapshot.
end function

function DeltaWhiteLabelPlayerUrl(action as String) as String
    return DeltaWhiteLabelApiOrigin() + "/api/v1/player-apps/" + DeltaWhiteLabelAppKey() + "/" + action
end function

function DeltaWhiteLabelAppName() as String
    c = WLAppearance()
    if c <> invalid and ToText(c.brandName) <> "" then return ToText(c.brandName)
    return "Meu aplicativo"
end function

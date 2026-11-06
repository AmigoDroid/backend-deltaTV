' ============================================================
' Pre-carrega, em segundo plano, TV ao vivo, filmes e series na memoria local (tmp:/ - ver XtMemWrite em Xtream.brs).
' Uma requisicao pesada por tipo; cada tipo fica disponivel assim que termina. Falha em um tipo nao impede os outros
' (as telas usam o provedor para o que nao estiver na memoria).
' ============================================================
sub init()
    m.top.functionName = "runPreload"
end sub

sub runPreload()
    conn = XtGetConfig()
    if not conn.ok then
        m.top.result = { ok: false, message: conn.message, clearAuth: conn.clearAuth }
        return
    end if
    cfg = conn.cfg

    XtMemPickRoot() ' cachefs:/ (persistente) se o aparelho permitir
    anyOk = false
    for each kind in ["live", "movie", "series"]
        ' catalogo salvo recente (menos de 6 h) e da mesma lista: nao baixa de novo (abre na hora, sem rede)
        age = XtMemAge(kind)
        if age >= 0 and age < 21600 then
            print "[DeltaTV] memoria: " + kind + " ja salvo (idade " + age.toStr() + "s) - sem download"
            anyOk = true
        else
            if PreloadKind(cfg, kind) then anyOk = true
        end if
        sleep(50)
    end for
    m.top.result = { ok: anyOk, message: "", clearAuth: false }
end sub

' baixa um tipo (categorias + lista completa) e grava no disco. true se gravou.
function PreloadKind(cfg as Object, kind as String) as Boolean
    ok = false
    g = XtGroups(cfg, kind)
    if g.ok then
        lst = XtAllList(cfg, kind, false)
        if lst.ok then
            items = lst.items
            lst = invalid
            if XtMemWrite(kind, g.data.groups, items) then
                print "[DeltaTV] memoria: " + kind + " pronto (" + items.count().toStr() + " itens)"
                ok = true
            else
                print "[DeltaTV] memoria: " + kind + " nao coube no armazenamento (usa o provedor)"
            end if
            items = invalid
        else
            print "[DeltaTV] memoria: " + kind + " falhou: " + lst.message
        end if
    else
        print "[DeltaTV] memoria: categorias de " + kind + " falharam: " + g.message
    end if
    return ok
end function

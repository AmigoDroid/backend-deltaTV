' ============================================================
' Pesquisa ao vivo: fica rodando e atende um pedido por letra digitada.
' Se chegam varios pedidos enquanto trabalha, so o MAIS RECENTE e processado (os antigos ja nao interessam).
' ============================================================
sub init()
    print "[DeltaTV][TRACE] SearchTask.init: inicializando Task"
    m.top.functionName = "runLoop"
end sub

sub runLoop()
    print "[DeltaTV][TRACE] SearchTask.runLoop: INICIO"
    port = CreateObject("roMessagePort")
    m.top.observeField("request", port)
    print "[DeltaTV][TRACE] SearchTask.runLoop: observando campo request"
    st = {}
    while true
        msg = wait(0, port)
        print "[DeltaTV][TRACE] SearchTask.runLoop: evento recebido tipo=" + type(msg)
        if type(msg) = "roSGNodeEvent" then
            req = msg.getData()
            if type(req) = "roAssociativeArray" then print "[DeltaTV][TRACE] SearchTask.runLoop: pedido recebido reqId=" + ToText(req.reqId) + " kind=" + ToText(req.kind) + " term=[" + ToText(req.term) + "]"
            ' descarta pedidos velhos que ficaram na fila
            while true
                newer = port.GetMessage()
                if newer = invalid then exit while
                print "[DeltaTV][TRACE] SearchTask.runLoop: fila extra tipo=" + type(newer)
                if type(newer) = "roSGNodeEvent" then
                    req = newer.getData()
                    if type(req) = "roAssociativeArray" then print "[DeltaTV][TRACE] SearchTask.runLoop: substituindo por pedido mais recente reqId=" + ToText(req.reqId) + " term=[" + ToText(req.term) + "]"
                end if
            end while
            if type(req) = "roAssociativeArray" then
                print "[DeltaTV][TRACE] SearchTask.runLoop: chamando answer reqId=" + ToText(req.reqId) + " term=[" + ToText(req.term) + "]"
                answer(st, req)
            else
                print "[DeltaTV][TRACE] SearchTask.runLoop: PAROU pedido nao e AssociativeArray"
            end if
        end if
    end while
end sub

sub answer(st as Object, req as Object)
    print "[DeltaTV][TRACE] SearchTask.answer: ENTRADA reqId=" + ToText(req.reqId) + " kind=" + ToText(req.kind) + " term=[" + ToText(req.term) + "] limit=" + ToText(req.limit)
    print "[DeltaTV][TRACE] SearchTask.answer: chamando XtMemSearchFast"
    r = XtMemSearchFast(st, ToText(req.kind), ToText(req.term), Int(Val(ToText(req.limit))))
    print "[DeltaTV][TRACE] SearchTask.answer: XtMemSearchFast retornou invalid=" + ToText(r = invalid)
    if r = invalid then
        print "[DeltaTV][TRACE] SearchTask.answer: escrevendo resultado fallback reqId=" + ToText(req.reqId)
        m.top.result = { reqId: req.reqId, ok: false, fallback: true, clearAuth: false, message: "" }
    else
        print "[DeltaTV][TRACE] SearchTask.answer: escrevendo resultado OK reqId=" + ToText(req.reqId)
        m.top.result = { reqId: req.reqId, ok: true, fallback: false, clearAuth: false, message: "", data: r.data }
    end if
end sub

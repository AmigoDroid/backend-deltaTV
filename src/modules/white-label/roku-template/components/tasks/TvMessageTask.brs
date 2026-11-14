sub init()
    m.top.functionName = "runMessage"
end sub
sub runMessage()
    p = m.top.params
    token = ToText(p.accessToken)
    if ToText(p.action) = "read" then
        result = HttpJson(DeltaClientUrl("/messages/" + ToText(p.id) + "/read"), "POST", "{}", token)
    else
        result = HttpJson(DeltaClientUrl("/messages"), "GET", "", token)
    end if
    m.top.params = {}
    m.top.result = result
end sub

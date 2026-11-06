' Downloads a small published appearance document off the UI thread.
' No credentials are needed and a network failure keeps the last cached theme.
sub init()
    m.top.functionName = "run"
end sub
sub run()
    key = m.top.appKey
    if key = "" then
        m.top.result = { ok: false }
        return
    end if
    result = HttpJson(DeltaWhiteLabelApiOrigin() + "/api/v1/player-apps/" + key + "/appearance", "GET", "", "", 8000)
    if result.status = 200 and type(result.data) = "roAssociativeArray" then
        m.top.result = { ok: true, data: result.data }
    else
        m.top.result = { ok: false }
    end if
end sub

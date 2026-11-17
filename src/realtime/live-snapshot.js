// Captura de sessões/reprodução removida: nenhuma Map, timer ou histórico.
// Status online vem de presence.js ou do canal WebSocket.
export function deviceOnline(_id,_data={}) {}
export function livePlayback(_id,_info,_ip) {}
export function liveForDevice(_id) {
  return {online:false,state:'unavailable',source:'disabled',retention:'none',
    playback:null,usage:null,lastSeenAt:null};
}
export function cleanLiveSnapshots() {}

/** Motor de diagnóstico PURO: sem I/O, sem operações destrutivas e sem segredos.
 * O acesso real continua a ser decidido exclusivamente por checkActivation.
 */
export const ACTIONS = Object.freeze({
  renew_license: 'Conferir ou renovar a licença do aplicativo.',
  review_partner: 'Conferir o contrato e o estado da parceria.',
  unblock: 'Verificar o motivo do bloqueio antes de reativar.',
  change_server: 'Verificar o servidor IPTV e testar uma alternativa autorizada.',
  inspect_player: 'Consultar os últimos erros do player e testar a reprodução.',
  reconnect: 'Pedir ao cliente que abra o aplicativo e verificar a conexão.',
  renew_service: 'Confirmar a renovação do serviço cadastrado pela revenda.',
  observe: 'Acompanhar o dispositivo. Nenhuma correção automática é necessária.',
});
const LICENSE_ISSUES = new Set(['LICENSE_EXPIRED','LICENSE_CANCELLED','LICENSE_SUSPENDED','LICENSE_BLOCKED','NO_LICENSE','LICENSE_NOT_STARTED']);
const PARTNER_ISSUES = new Set(['PARTNER_BLOCKED','PARTNER_SUSPENDED','PARTNER_CANCELLED','PARTNER_DELETED','PARTNER_NOT_STARTED','PARTNER_EXPIRED','PARTNER_DELINQUENT','PARTNER_CODE_REVOKED']);

/** Resultados são indícios: só afirmar uma causa quando a decisão de acesso confirma. */
export function assessSupport({ access, connection, playback, provider, commercial, recentEvent } = {}) {
  const findings = [];
  const add = (severity, code, title, evidence, nextAction) => findings.push({ severity, code, title, evidence, nextAction });
  if (!access) {
    add('unknown','ACCESS_NOT_CHECKED','Não foi possível confirmar a licença','A validação do backend ainda não retornou um estado.','Repetir o diagnóstico e verificar os logs da API.');
  } else if (!access.allowed) {
    const code = String(access.code || 'ACCESS_DENIED');
    const action = LICENSE_ISSUES.has(code) ? ACTIONS.renew_license : PARTNER_ISSUES.has(code) ? ACTIONS.review_partner : ACTIONS.unblock;
    add('critical',code,'Acesso não autorizado',`A API recusou esta ativação: ${code}.`,action);
  }
  if (commercial?.daysLeft != null && Number(commercial.daysLeft) < 0) {
    add('warning','COMMERCIAL_OVERDUE','Vencimento comercial ultrapassado',`Vencimento da ficha comercial há ${Math.abs(Number(commercial.daysLeft))} dia(s). Não equivale a bloqueio da licença.`,ACTIONS.renew_service);
  }
  if (provider?.state === 'down' && provider?.fresh) {
    add('warning','PROVIDER_DOWN','Servidor IPTV indisponível nas sondagens','O monitor de servidores registrou falha recente. A origem selecionada na reprodução pode ser diferente.',ACTIONS.change_server);
  } else if (provider?.state === 'suspect' && provider?.fresh) {
    add('warning','PROVIDER_SUSPECT','Servidor IPTV instável nas sondagens','O monitor registrou falhas recentes, mas ainda não confirmou indisponibilidade.',ACTIONS.change_server);
  }
  if (connection?.online && playback?.state === 'buffering') {
    add('warning','PLAYER_BUFFERING','TV apresenta buffering','O último estado informado pelo player foi buffering.',ACTIONS.inspect_player);
  } else if (connection?.online && playback?.state === 'error') {
    add('warning','PLAYER_ERROR','TV informou erro de reprodução','O estado de reprodução atual indica erro.',ACTIONS.inspect_player);
  } else if (connection?.online && recentEvent?.state === 'error' && recentEvent?.fresh) {
    add('warning','RECENT_PLAYBACK_ERROR','Erro recente de reprodução',`Auditoria registrou erro${recentEvent.errorCode ? ` (${recentEvent.errorCode})` : ''}.`,ACTIONS.inspect_player);
  }
  if (connection && !connection.online) {
    add('unknown','DEVICE_NOT_REACHABLE','Sem conexão recente da TV','A API não recebeu presença recente; isso não comprova defeito na internet ou que a TV esteja desligada.',ACTIONS.reconnect);
  }
  if (!findings.length) {
    if (connection?.online && access?.allowed) add('ok','NO_ISSUE_REPORTED','Nenhum problema evidente','Licença autorizada e TV com sinal recente. Isso não garante reprodução sem falhas.',ACTIONS.observe);
    else add('unknown','INSUFFICIENT_DATA','Informações insuficientes','Não existem sinais suficientes para apontar uma causa com segurança.',ACTIONS.reconnect);
  }
  const priority = { critical: 0, warning: 1, unknown: 2, ok: 3 };
  findings.sort((a,b)=>priority[a.severity]-priority[b.severity]);
  return { status: findings[0].severity, headline: findings[0].title, nextAction: findings[0].nextAction, findings };
}

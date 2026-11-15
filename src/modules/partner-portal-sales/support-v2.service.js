import {QueryTypes} from 'sequelize';
import {sequelize} from '../../db/models/index.js';
import {AppError} from '../../shared/errors.js';
import {audit} from '../../shared/audit.js';
const fail=(s,c,m)=>{throw new AppError(s,c,m);};
const read=(sql,p={},t)=>sequelize.query(sql,{replacements:p,type:QueryTypes.SELECT,transaction:t});
const one=async(sql,p={},t)=>(await read(sql,p,t))[0]||null;
const write=(sql,p={},t)=>sequelize.query(sql,{replacements:p,transaction:t});
/** Only creator, assigned support desk, or DeltaTV sees a ticket.
 * Internal notes are DeltaTV-only, even if a partner was reassigned later.
 */
async function ticket(id,actor,t){
 const row=await one('SELECT * FROM partner_portal_support_tickets WHERE id=:id',{id},t);
 if(!row)fail(404,'TICKET_NOT_FOUND','Chamado não encontrado.');
 const admin=actor.type==='admin'&&actor.role==='superadmin';
 if(!admin&&!([row.creator_partner_id,row.assigned_partner_id].includes(actor.partnerId)))
   fail(404,'TICKET_NOT_FOUND','Chamado não encontrado.');
 return row;
}
export async function openTicket({subject,category,priority='normal',destination='deltatv',message},actor){
 if(actor.type!=='partner'||!actor.partnerId)fail(403,'PARTNER_REQUIRED','Somente parceiros abrem chamados nesta área.');
 return sequelize.transaction(async t=>{
  let assigned=null;
  if(destination==='master'){
   const parent=await one(`SELECT COALESCE(s.parent_partner_id,c.seller_partner_id) AS owner_id, p.status
      FROM partners own LEFT JOIN partner_portal_sellers s ON s.partner_id=own.id
      LEFT JOIN partner_portal_access_contracts c ON c.customer_partner_id=own.id
      LEFT JOIN partners p ON p.id=COALESCE(s.parent_partner_id,c.seller_partner_id)
      WHERE own.id=:id`,{id:actor.partnerId},t);
   if(!parent?.owner_id||parent.status!=='active')fail(409,'NO_MASTER_SUPPORT','Sua conta não possui Master responsável ativo. Escolha a DeltaTV.');
   assigned=parent.owner_id;
  }
  const result=await one(`INSERT INTO partner_portal_support_tickets
    (creator_partner_id,assigned_partner_id,subject,category,priority)
    VALUES(:creator,:assigned,:subject,:category,:priority) RETURNING *`,
   {creator:actor.partnerId,assigned,subject,category,priority},t);
  await write(`INSERT INTO partner_portal_support_messages(ticket_id,author_partner_id,body)
   VALUES(:id,:author,:body)`,{id:result.id,author:actor.partnerId,body:message},t);
  await audit({actor,action:'portal.support.created',entityType:'portal_support_ticket',entityId:result.id,
   metadata:{assignedPartnerId:assigned,category,priority},transaction:t});
  return {id:result.id,protocol:String(result.protocol),status:result.status};
 });
}
export async function ticketsFor(actor){
 const admin=actor.type==='admin'&&actor.role==='superadmin';
 if(!admin&&actor.type!=='partner')fail(403,'FORBIDDEN','Acesso negado.');
 return read(`SELECT t.id,t.protocol,t.subject,t.category,t.priority,t.status,t.created_at,t.updated_at,
  c.name AS creator_name,assigned.name AS assigned_name,t.creator_partner_id,t.assigned_partner_id
 FROM partner_portal_support_tickets t JOIN partners c ON c.id=t.creator_partner_id
 LEFT JOIN partners assigned ON assigned.id=t.assigned_partner_id
 ${admin?'':'WHERE t.creator_partner_id=:partnerId OR t.assigned_partner_id=:partnerId'}
 ORDER BY t.updated_at DESC LIMIT 200`,{partnerId:actor.partnerId});
}
export async function ticketDetail(id,actor){
 const row=await ticket(id,actor);
 const admin=actor.type==='admin'&&actor.role==='superadmin';
 const messages=await read(`SELECT id,author_partner_id,author_admin_id,body,internal,created_at
  FROM partner_portal_support_messages WHERE ticket_id=:id ${admin?'':'AND internal=false'} ORDER BY created_at`,{id});
 return {ticket:row,messages};
}
export async function replyTicket(id,{body,internal=false,status},actor){
 return sequelize.transaction(async t=>{
  const row=await ticket(id,actor,t);
  const admin=actor.type==='admin'&&actor.role==='superadmin';
  if(internal&&!admin)fail(403,'INTERNAL_NOTE_DENIED','Notas internas são exclusivas da DeltaTV.');
  if(status&&row.creator_partner_id===actor.partnerId&&!['open','resolved'].includes(status))
   fail(403,'STATUS_DENIED','Somente o atendimento pode alterar este status.');
  await write(`INSERT INTO partner_portal_support_messages(ticket_id,author_partner_id,author_admin_id,body,internal)
   VALUES(:id,:partner,:admin,:body,:internal)`,{
     id,partner:admin?null:actor.partnerId,admin:admin?actor.id:null,body,internal},t);
  await write(`UPDATE partner_portal_support_tickets SET status=:status,updated_at=now() WHERE id=:id`,
   {id,status:status||row.status},t);
  await audit({actor,action:'portal.support.replied',entityType:'portal_support_ticket',entityId:id,
   metadata:{status:status||row.status,internal},transaction:t});
  return {ok:true};
 });
}
export async function assignTicket(id,destination,actor){
 if(actor.type!=='admin'||actor.role!=='superadmin')fail(403,'DELTATV_ONLY','Apenas a DeltaTV pode direcionar chamados globais.');
 return sequelize.transaction(async t=>{
  await ticket(id,actor,t);
  if(destination){const dest=await one(`SELECT 1 FROM partner_portal_sellers WHERE partner_id=:destination AND active=true`,{destination},t);
   if(!dest)fail(404,'MASTER_NOT_FOUND','Master destinatário não encontrado.');}
  await write(`UPDATE partner_portal_support_tickets SET assigned_partner_id=:destination,updated_at=now() WHERE id=:id`,{id,destination},t);
  await audit({actor,action:'portal.support.assigned',entityType:'portal_support_ticket',entityId:id,metadata:{destination},transaction:t});
  return {ok:true};
 });
}

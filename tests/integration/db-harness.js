process.env.NODE_ENV="test";
import {PGlite} from '@electric-sql/pglite';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {Sequelize}=require('sequelize');
export async function setupDatabase(){
 const db=new PGlite();
 // Test adapter only. Sequelize still generates and parses the actual PostgreSQL SQL.
 const connection={query(sql,params,callback){
   if(typeof params==='function'){callback=params;params=[];}
   const run= params?.length ? db.query(sql,params) : db.exec(sql).then(r=>r.length===1?r[0]:r);
   run.then(result=>{
     const convert=r=>({...r,rowCount:r.affectedRows||r.rows?.length||0,command:sql.trim().split(/\s/)[0].toUpperCase()});
     callback(null,Array.isArray(result)?result.map(convert):convert(result));
   },callback);
 }};
 const {sequelize}=await import('../../src/db/sequelize.js');
 sequelize.options.databaseVersion='17.0.0';
 sequelize.connectionManager.getConnection=async()=>connection;
 sequelize.connectionManager.releaseConnection=async()=>{};
 return {db,sequelize,Sequelize,async close(){await sequelize.close();await db.close();}};
}

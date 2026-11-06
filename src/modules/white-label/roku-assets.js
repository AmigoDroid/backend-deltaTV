import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { AppError } from '../../shared/errors.js';
import { crc32 } from './roku-zip.js';

const ROOT = path.resolve(process.env.WHITE_LABEL_ASSETS_DIR || './storage/white-label-assets');
export const ASSET_SIZES = Object.freeze({
  logo: [[180,180],[400,400]], icon_hd: [[336,210]], icon_sd: [[246,140]],
  splash_hd: [[1280,720]], splash_fhd: [[1920,1080]],
  banner: [[1020,314]], connect: [[1280,720]],
});
const ASSET_FILES = Object.freeze({ logo:'images/logo.png',icon_hd:'images/brand_icon_hd.png',
  icon_sd:'images/brand_icon_sd.png',splash_hd:'images/brand_splash_hd.png',
  splash_fhd:'images/brand_splash_fhd.png',banner:'images/brand_banner.png',
  connect:'images/brand_connect.png' });
export const ASSET_MAX_BYTES = 3_000_000;
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
function assetPath(appId, kind) {
  if (!/^[0-9a-f-]{36}$/i.test(appId) || !Object.hasOwn(ASSET_SIZES,kind))
    throw new AppError(422,'BAD_ASSET','Identificação do arquivo inválida.');
  return path.join(ROOT,appId,`${kind}.png`);
}
export function validateRokuPng(kind, bytes) {
  if (!Object.hasOwn(ASSET_SIZES,kind)) throw new AppError(422,'BAD_ASSET_KIND','Tipo de imagem desconhecido.');
  if (!Buffer.isBuffer(bytes) || bytes.length<58 || bytes.length>ASSET_MAX_BYTES || !bytes.subarray(0,8).equals(signature))
    throw new AppError(422,'INVALID_PNG','Envie uma imagem PNG de até 3 MB.');
  if(bytes.readUInt32BE(8)!==13 || bytes.toString('ascii',12,16)!=='IHDR')
    throw new AppError(422,'INVALID_PNG','PNG sem cabeçalho válido.');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),bitDepth=bytes[24],colorType=bytes[25];
  if(!ASSET_SIZES[kind].some(([w,h])=>w===width&&h===height) || bitDepth!==8 || ![2,6].includes(colorType))
    throw new AppError(422,'WRONG_IMAGE_SIZE',`Tamanho inválido. ${kind}: ${ASSET_SIZES[kind].map(a=>a.join('×')).join(' ou ')} pixels, PNG RGB/RGBA 8 bits.`);
  if (bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0)
    throw new AppError(422,'INVALID_PNG','PNG precisa usar compressão padrão, sem entrelaçamento.');
  let offset=8, hasIhdr=false, hasIend=false, idatSeen=false;
  const compressed=[];
  while(offset < bytes.length) {
    if(offset+12>bytes.length) throw new AppError(422,'INVALID_PNG','PNG incompleto.');
    const n=bytes.readUInt32BE(offset), tag=bytes.toString('ascii',offset+4,offset+8);
    if(n>ASSET_MAX_BYTES || offset+12+n>bytes.length)
      throw new AppError(422,'INVALID_PNG','Tamanho interno da imagem inválido.');
    const chunk=bytes.subarray(offset+4,offset+8+n), checksum=bytes.readUInt32BE(offset+8+n);
    if(crc32(chunk)!==checksum) throw new AppError(422,'INVALID_PNG','CRC da imagem inválido.');
    if(tag==='IHDR') {
      if(hasIhdr || offset!==8 || n!==13) throw new AppError(422,'INVALID_PNG','IHDR duplicado ou inválido.');
      hasIhdr=true;
    } else if (tag==='IDAT') {
      if(!hasIhdr || hasIend) throw new AppError(422,'INVALID_PNG','Dados da imagem fora de ordem.');
      compressed.push(bytes.subarray(offset+8,offset+8+n));idatSeen=true;
    } else if (tag==='IEND') {
      if(n!==0 || !idatSeen || offset+12!==bytes.length)
        throw new AppError(422,'INVALID_PNG','Fim da imagem inválido.');
      hasIend=true;
    } else if (/^[A-Z]/.test(tag)) {
      // Unknown critical chunks, APNG extensions and alternative image formats are not supported.
      if(tag!=='PLTE') throw new AppError(422,'INVALID_PNG','Tipo de PNG não suportado.');
    }
    offset+=12+n;
  }
  if(!hasIhdr || !hasIend || !idatSeen) throw new AppError(422,'INVALID_PNG','PNG incompleto.');
  const stride=width*(colorType===6 ? 4 : 3)+1;
  const expected=stride*height;
  let decoded;
  try { decoded=inflateSync(Buffer.concat(compressed),{maxOutputLength:expected+1}); }
  catch { throw new AppError(422,'INVALID_PNG','Não foi possível descompactar a imagem PNG.'); }
  if(decoded.length!==expected) throw new AppError(422,'INVALID_PNG','Imagem PNG com dimensões internas incorretas.');
  for(let y=0;y<height;y++) {
    if(decoded[y*stride]>4) throw new AppError(422,'INVALID_PNG','Filtro de linha PNG inválido.');
  }
  return {width,height,size:bytes.length};
}
export async function storeRokuAsset(appId, kind, bytes) {
  const details=validateRokuPng(kind,bytes);
  const target=assetPath(appId,kind);
  await fs.mkdir(path.dirname(target),{recursive:true,mode:0o750});
  const tmp=`${target}.${randomUUID()}.tmp`;
  try {await fs.writeFile(tmp,bytes,{mode:0o640,flag:'wx'});await fs.rename(tmp,target);}
  finally {await fs.rm(tmp,{force:true}).catch(()=>{});}
  return details;
}
export async function listRokuAssets(appId) {
  const data={};
  for(const [kind,dimensions] of Object.entries(ASSET_SIZES)) {
    const stat=await fs.stat(assetPath(appId,kind)).catch(()=>null);
    data[kind]={present:!!stat,dimensions,bytes:stat?.size??null};
  }
  return data;
}
export async function loadRokuAssets(appId) {
  const images={};
  for(const kind of Object.keys(ASSET_SIZES)) {
    const bytes=await fs.readFile(assetPath(appId,kind)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(bytes) {validateRokuPng(kind,bytes);images[ASSET_FILES[kind]]=bytes;}
  }
  return images;
}

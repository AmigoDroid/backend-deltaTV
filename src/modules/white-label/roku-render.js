// Deterministic, dependency-free placeholder art. Brand owners can replace it with
// commissioned logo/splash art before signing. No third-party images are embedded.
import { deflateSync } from 'node:zlib';
import { crc32 } from './roku-zip.js';
const glyphs = {
 A:['01110','10001','10001','11111','10001','10001','10001'], B:['11110','10001','10001','11110','10001','10001','11110'],
 C:['01111','10000','10000','10000','10000','10000','01111'], D:['11110','10001','10001','10001','10001','10001','11110'],
 E:['11111','10000','10000','11110','10000','10000','11111'], F:['11111','10000','10000','11110','10000','10000','10000'],
 G:['01111','10000','10000','10111','10001','10001','01111'], H:['10001','10001','10001','11111','10001','10001','10001'],
 I:['11111','00100','00100','00100','00100','00100','11111'], J:['00111','00010','00010','00010','10010','10010','01100'],
 K:['10001','10010','10100','11000','10100','10010','10001'], L:['10000','10000','10000','10000','10000','10000','11111'],
 M:['10001','11011','10101','10101','10001','10001','10001'], N:['10001','11001','10101','10011','10001','10001','10001'],
 O:['01110','10001','10001','10001','10001','10001','01110'], P:['11110','10001','10001','11110','10000','10000','10000'],
 Q:['01110','10001','10001','10001','10101','10010','01101'], R:['11110','10001','10001','11110','10100','10010','10001'],
 S:['01111','10000','10000','01110','00001','00001','11110'], T:['11111','00100','00100','00100','00100','00100','00100'],
 U:['10001','10001','10001','10001','10001','10001','01110'], V:['10001','10001','10001','10001','10001','01010','00100'],
 W:['10001','10001','10001','10101','10101','10101','01010'], X:['10001','10001','01010','00100','01010','10001','10001'],
 Y:['10001','10001','01010','00100','00100','00100','00100'], Z:['11111','00001','00010','00100','01000','10000','11111'],
 '0':['01110','10011','10101','10101','11001','10001','01110'],
 '1':['00100','01100','00100','00100','00100','00100','01110'],
 '2':['11110','00001','00001','01110','10000','10000','11111'],
 '3':['11110','00001','00001','01110','00001','00001','11110'],
 '4':['10010','10010','10010','11111','00010','00010','00010'],
 '5':['11111','10000','10000','11110','00001','00001','11110'],
 '6':['01111','10000','10000','11110','10001','10001','01110'],
 '7':['11111','00001','00010','00100','01000','01000','01000'],
 '8':['01110','10001','10001','01110','10001','10001','01110'],
 '9':['01110','10001','10001','01111','00001','00001','11110'],
 ' ':['00000','00000','00000','00000','00000','00000','00000'],
};
function chunk(tag, data) {
  const typ = Buffer.from(tag); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typ, data])));
  return Buffer.concat([size, typ, data, crc]);
}
export function pngImage(width, height, bg = '#101321', accent = '#6B47E6', label = 'TV') {
  if (width > 1920 || height > 1080 || width < 10 || height < 10) throw Error('Dimensão não suportada.');
  const hex = s => [1,3,5].map(i => parseInt(s.slice(i,i+2),16));
  const base = hex(bg), highlight = hex(accent);
  const stride = width * 4 + 1, rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const off = y * stride;
    for (let x = 0; x < width; x++) {
      const o = off + 1 + 4*x;
      const tint = Math.max(0, Math.min(1, (x/width)*.4 + ((height-y)/height)*.13));
      const stripe = y < Math.max(4, height/20) ? .45 : 0;
      const a = Math.min(.75, tint + stripe);
      rows[o] = Math.round(base[0]*(1-a)+highlight[0]*a);
      rows[o+1] = Math.round(base[1]*(1-a)+highlight[1]*a);
      rows[o+2] = Math.round(base[2]*(1-a)+highlight[2]*a);
      rows[o+3] = 255;
    }
  }
  const upper = String(label).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g,'').trim().slice(0, 12) || 'TV';
  const scale = Math.max(1, Math.floor(Math.min(width/((upper.length * 6)*1.7), height/13)));
  const textWidth = upper.length*6*scale- scale;
  const x0 = Math.floor((width-textWidth)/2), y0 = Math.floor((height-7*scale)/2);
  for (let i=0;i<upper.length;i++) {
    const shape=glyphs[upper[i]]||glyphs[' '];
    for(let yy=0;yy<7;yy++) for(let xx=0;xx<5;xx++) if(shape[yy][xx]==='1') {
      for(let dy=0;dy<scale;dy++) for(let dx=0;dx<scale;dx++) {
        const x=x0+(i*6+xx)*scale+dx, y=y0+yy*scale+dy;
        if(x<0||x>=width||y<0||y>=height) continue;
        const p=y*stride+1+x*4;
        rows[p]=248;rows[p+1]=250;rows[p+2]=255;rows[p+3]=255;
      }
    }
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows,{level:7})),chunk('IEND',Buffer.alloc(0))]);
}

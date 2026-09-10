import {PDFDocument} from 'pdf-lib';
/** Preserves the supplied rendered slide images; this is deliberately raster PDF output. */
export async function renderedImagesPdf(input){
 const {pngsBase64,widthPx,heightPx}=input??{};
 if(!Array.isArray(pngsBase64)||pngsBase64.length<1||pngsBase64.length>100)throw Error('Choose between 1 and 100 rendered slides.');
 if(![widthPx,heightPx].every(n=>Number.isFinite(n)&&n>0&&n<=10000))throw Error('Invalid slide dimensions.');
 let total=0;for(const image of pngsBase64){if(typeof image!=='string'||!image.startsWith('iVBORw0KGgo')||!/^[-A-Za-z0-9+/]*={0,2}$/.test(image))throw Error('Expected a rendered PNG slide.');total+=image.length;}
 if(total>32*1024*1024)throw Error('Rendered slides exceed the 32 MB export limit. Export fewer slides at a time.');
 const pdf=await PDFDocument.create();pdf.setCreator('Seeger Weiss Slides Web');
 for(const image of pngsBase64){const embedded=await pdf.embedPng(image),width=widthPx*.75,height=heightPx*.75;const page=pdf.addPage([width,height]);page.drawImage(embedded,{x:0,y:0,width,height});}
 return pdf.save();
}

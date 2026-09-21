import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import { Schema, type Node as PmNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';
import { executeBrowserWriterTool, BROWSER_WRITER_TOOLS } from '../../writer/renderer/ai/browser-tools';
import { getSelectionScope } from '../../writer/renderer/ai/protocol';
import { parseDocx } from '../../writer/packages/docx-engine/src/parse';
import { saveDocx } from '../../writer/packages/docx-engine/src/patch';
import { blocksToPmDoc, pmDocToSavePlan } from '../../writer/renderer/editor/convert';
import { mergeStylesXml, pendingHeadingLevel } from '../../writer/packages/docx-engine/src/style-upsert';
import { removeNoteRefs, editNoteText } from '../../writer/renderer/ai/note-ops';
import { applyRevisionSelection, listRevisionEntries } from '../../writer/renderer/ai/revision-ops';
import { textBoxNode, pictureNode } from '../../writer/renderer/ai/floating-ops';
import { allowedTools } from '../../writer/shared/sw-policy';
import { addCommentAtRange, removeCommentFromDoc } from '../../writer/renderer/editor/comments';
import { previewStyleDefinitions } from '../../writer/renderer/ai/style-preview';
import { resolveStyleDefinition } from '../../writer/renderer/ai/style-ops';
import { writerPageContext } from '../../writer/renderer/ai/page-context';
import { parseEmu } from '../../writer/renderer/ai/lengths';
import type { AiCommentsAccess, AiDocumentAccess } from '../../writer/renderer/ai/tools';
import type { CommentInfo, NoteInfo } from '../../writer/packages/docx-engine/src/types';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function packageOf(body = '<w:p><w:r><w:t>Before selected after</w:t></w:r></w:p><w:p><w:r><w:t>Untouched final paragraph</w:t></w:r></w:p>') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml',`<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  zip.file('word/styles.xml',`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="180" w:line="240" w:lineRule="auto"/><w:keepNext/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="SimSun"/><w:color w:val="102030"/></w:rPr><w:uiPriority w:val="42"/><w:rsid w:val="11223344"/></w:style></w:styles>`);
  zip.file('customXml/untouched.xml','<firm>Preserve this exact private source part.</firm>');
  const bytes=await zip.generateAsync({type:'uint8array'});
  return {bytes, parsed: await parseDocx(bytes)};
}

function editorFor(content: ReturnType<typeof blocksToPmDoc>) {
  const attrs: Record<string,{default:any}> = {};
  const textAttrs: Record<string,{default:any}> = {};
  const visit=(node:any)=>{ for(const key of Object.keys(node.attrs??{})) attrs[key]={default:null}; for(const mark of node.marks??[]) if(mark.type==='docTextStyle') for(const key of Object.keys(mark.attrs??{})) textAttrs[key]={default:null}; for(const child of node.content??[]) visit(child); }; visit(content);
  Object.assign(attrs,{docxIndex:{default:null},aiChanged:{default:false},blockRevision:{default:null},level:{default:1},styleId:{default:null},kind:{default:'footnote'},id:{default:''},num:{default:1},pPrChange:{default:null}});
  const schema=new Schema({nodes:{doc:{content:'block+'},text:{group:'inline'},docParagraph:{group:'block',content:'inline*',attrs},docHeading:{group:'block',content:'inline*',attrs},docListItem:{group:'block',content:'inline*',attrs},docProtected:{group:'block',atom:true,attrs},docTable:{group:'block',content:'docTableRow+',attrs},docTableRow:{content:'(docTableCell|docTableHeader)+',attrs},docTableCell:{content:'block+',attrs},docTableHeader:{content:'block+',attrs},docNoteRef:{group:'inline',inline:true,atom:true,attrs},hardBreak:{inline:true,group:'inline'}},marks:{bold:{},italic:{},underline:{},strike:{},ins:{attrs:{author:{default:''},date:{default:null}}},del:{attrs:{author:{default:''},date:{default:null}}},comment:{attrs:{ids:{default:''}}},docTextStyle:{attrs:Object.keys(textAttrs).length?textAttrs:{color:{default:null},sizeHalfPoints:{default:null},font:{default:null}}},link:{attrs:{href:{default:null},rId:{default:null}}}}});
  let state=EditorState.create({schema,doc:schema.nodeFromJSON(content)});
  const editor={get state(){return state},schema,storage:{},commands:{setTextSelection:({from,to}:{from:number,to:number})=>{state=state.apply(state.tr.setSelection(TextSelection.create(state.doc,from,to)));return true}},view:{dispatch:(tr:any)=>{state=state.apply(tr)}},getJSON:()=>state.doc.toJSON()} as unknown as Editor;
  return editor;
}
const nums={bullet:null,ordered:null};
const call=(name:string,input:Record<string,unknown>)=>({id:'test',name,input});

test('exact highlighted deletion persists native DOCX and preserves surrounding text and unrelated parts',async()=>{
  const {parsed}=await packageOf();
  const editor=editorFor(blocksToPmDoc(parsed.blocks));
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc,8,16)));
  const frozen={scope:getSelectionScope(editor),doc:editor.state.doc};
  // Moving the cursor to the end cannot retarget a captured request.
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
  const result=executeBrowserWriterTool(editor,call('replace_selection',{html:''}),nums,undefined,frozen,undefined,undefined)!;
  assert.equal(result.isError,undefined); assert.equal(result.mutated,true);
  assert.equal(editor.state.doc.child(0).textContent,'Before  after');
  assert.equal(editor.state.doc.child(1).textContent,'Untouched final paragraph');
  const plan=pmDocToSavePlan(editor.getJSON() as ReturnType<typeof blocksToPmDoc>,parsed.blocks);
  const saved=await saveDocx(parsed,plan.saveBlocks);
  const reopened=await parseDocx(saved);
  assert.equal(editorFor(blocksToPmDoc(reopened.blocks)).state.doc.textContent,'Before  afterUntouched final paragraph');
  const zip=await JSZip.loadAsync(saved);
  assert.equal(await zip.file('customXml/untouched.xml')!.async('string'),'<firm>Preserve this exact private source part.</firm>');
});

test('stale captured selection fails closed and whole-document clear stays a distinct explicit native operation',async()=>{
  const {parsed}=await packageOf(); const editor=editorFor(blocksToPmDoc(parsed.blocks));
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc,8,16)));
  const frozen={scope:getSelectionScope(editor),doc:editor.state.doc};
  editor.view.dispatch(editor.state.tr.insertText('User ',1));
  const before=editor.state.doc;
  const stale=executeBrowserWriterTool(editor,call('replace_selection',{html:''}),nums,undefined,frozen,undefined,undefined)!;
  assert.equal(stale.isError,true); assert.equal(editor.state.doc,before);
  const accidental=executeBrowserWriterTool(editor,call('write_document',{html:''}),nums,undefined,null,undefined,undefined)!;
  assert.equal(accidental.isError,true); assert.equal(editor.state.doc,before);
  const cleared=executeBrowserWriterTool(editor,call('write_document',{html:'',replace:true}),nums,undefined,null,undefined,undefined)!;
  assert.equal(cleared.mutated,true); assert.equal(editor.state.doc.textContent,''); assert.equal(editor.state.doc.childCount,1);
  const saved=await saveDocx(parsed,pmDocToSavePlan(editor.getJSON() as ReturnType<typeof blocksToPmDoc>,parsed.blocks).saveBlocks);
  const zip=await JSZip.loadAsync(saved);
  const xml=await zip.file('word/document.xml')!.async('string');
  assert.ok(!xml.includes('Untouched final paragraph')); assert.match(xml,/<w:sectPr>/);
});

test('apply_ops rejects an invalid or unsafe operation atomically and applies native formatting once',async()=>{
  const {parsed}=await packageOf(); const editor=editorFor(blocksToPmDoc(parsed.blocks)); const before=editor.state.doc;
  for(const bad of [{op:'doesNotExist'},{op:'setFont',target:{blockIndexes:[0]},link:{url:'javascript:alert(1)'}}]){
    const failed=executeBrowserWriterTool(editor,call('apply_ops',{ops:[{op:'setFont',target:{blockIndexes:[0]},bold:true},bad]}),nums,undefined,null,undefined,undefined)!;
    assert.equal(failed.isError,true); assert.equal(editor.state.doc,before);
  }
  const good=executeBrowserWriterTool(editor,call('apply_ops',{ops:[{op:'setFont',target:{blockIndexes:[0]},bold:true}]}),nums,undefined,null,undefined,undefined)!;
  assert.equal(good.mutated,true); assert.ok(editor.state.doc.child(0).firstChild?.marks.some(m=>m.type.name==='bold'));
  assert.ok(!editor.state.doc.child(1).firstChild?.marks.some(m=>m.type.name==='bold'));
});

test('native style property patch preserves unrelated style properties and source parts on save',async()=>{
  const {parsed}=await packageOf(); const json=blocksToPmDoc(parsed.blocks);
  const saved=await saveDocx(parsed,pmDocToSavePlan(json,parsed.blocks).saveBlocks,{styleUpserts:[{styleId:'Normal',rPr:{bold:false,color:'172E4C'},pPr:{spaceAfterTwips:240}}]});
  const zip=await JSZip.loadAsync(saved); const styles=await zip.file('word/styles.xml')!.async('string');
  assert.match(styles,/<w:b w:val="0"\s*\/>/); assert.match(styles,/w:color w:val="172E4C"/);
  assert.match(styles,/w:after="240"/); assert.match(styles,/w:line="240"/); assert.match(styles,/w:eastAsia="SimSun"/);
  assert.match(styles,/<w:keepNext\s*\/>/); assert.match(styles,/<w:uiPriority w:val="42"\s*\/>/); assert.match(styles,/<w:rsid w:val="11223344"\s*\/>/);
  assert.equal(await zip.file('customXml/untouched.xml')!.async('string'),'<firm>Preserve this exact private source part.</firm>');
  assert.equal((await parseDocx(saved)).styles.get('Normal')?.display?.color,'172E4C');
});

test('note text replacement retains rich runs and reference deletion only removes the selected note',async()=>{
  const note={id:'3',text:'First citation',richParas:[[{text:'First ',bold:true},{text:'citation',italic:true}]]};
  const changed=editNoteText(note,'citation','authority');
  assert.equal(changed.note.text,'First authority'); assert.equal(changed.note.richParas?.[0]?.[1]?.italic,true); assert.equal(note.text,'First citation');
  const editor=editorFor({type:'doc',content:[{type:'docParagraph',content:[{type:'text',text:'A'},{type:'docNoteRef',attrs:{kind:'footnote',id:'3',num:1}},{type:'text',text:' B'},{type:'docNoteRef',attrs:{kind:'footnote',id:'4',num:2}}]}]});
  assert.equal(removeNoteRefs(editor,'footnote','3'),1);
  const refs:PmNode[]=[]; editor.state.doc.descendants(n=>{if(n.type.name==='docNoteRef') refs.push(n)});
  assert.equal(refs.length,1); assert.equal(refs[0]!.attrs.id,'4'); assert.equal(refs[0]!.attrs.num,1);
});

test('revision selectors accept only requested native changes and leave unrelated revisions pending',()=>{
  const editor=editorFor({type:'doc',content:[{type:'docParagraph',content:[{type:'text',text:'Alice edit',marks:[{type:'ins',attrs:{author:'Alice'}}]},{type:'text',text:' Bob edit',marks:[{type:'ins',attrs:{author:'Bob'}}]}]}]});
  assert.equal(listRevisionEntries(editor.state.doc).length,2);
  assert.ok(!('error' in applyRevisionSelection(editor,{author:'Alice'},'accept')));
  const left=listRevisionEntries(editor.state.doc); assert.equal(left.length,1); assert.equal(left[0]!.author,'Bob');
  assert.equal(editor.state.doc.textContent,'Alice edit Bob edit');
});

test('native text box exports actual editable Word drawing XML',async()=>{
  const built=textBoxNode({text:'Editable callout',width:'2in',height:'1in',x:'1in',y:'1in',anchor:'page'});
  assert.ok(!('error' in built)); if('error' in built) return;
  const {parsed}=await packageOf(); const json=blocksToPmDoc(parsed.blocks); json.content!.push(built.node as any);
  const saved=await saveDocx(parsed,pmDocToSavePlan(json,parsed.blocks).saveBlocks);
  const xml=await(await JSZip.loadAsync(saved)).file('word/document.xml')!.async('string');
  assert.match(xml,/Editable callout/); assert.match(xml,/w:txbxContent/); assert.match(xml,/wp:anchor/);
});

test('every new Writer definition is reachable in the permitted browser mode and mutations are excluded in Ask',()=>{
  for(const def of BROWSER_WRITER_TOOLS){ assert.ok(allowedTools('write').includes(def.name),def.name); assert.equal(allowedTools('ask').includes(def.name),def.readOnly===true,def.name); }
  assert.equal(new Set(BROWSER_WRITER_TOOLS.map(t=>t.name)).size,BROWSER_WRITER_TOOLS.length);
});


test('native comment creation preserves the cursor, exports real Word anchors, and deletion clears only its own thread', async () => {
  const {parsed}=await packageOf(); const editor=editorFor(blocksToPmDoc(parsed.blocks));
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
  const originalSelection=editor.state.selection.from;
  let comments: CommentInfo[]=[];
  const access: AiCommentsAccess={list:()=>comments,reply:()=>false,resolve:()=>false,
    add:(from,to,text)=>{const id=String(comments.length+1);if(!addCommentAtRange(editor,id,from,to)) return 'No anchor'; comments.push({id,author:'Synthetic reviewer',text});return{id}},
    remove:id=>{removeCommentFromDoc(editor,id);comments=comments.filter(c=>c.id!==id);return null}};
  const created=executeBrowserWriterTool(editor,call('add_comment',{blockIndex:0,text:'selected',comment:'Verify this exact phrase'}),nums,undefined,null,access,undefined)!;
  assert.equal(created.isError,undefined); assert.equal(editor.state.selection.from,originalSelection); assert.equal(comments.length,1);
  const saved=await saveDocx(parsed,pmDocToSavePlan(editor.getJSON() as ReturnType<typeof blocksToPmDoc>,parsed.blocks).saveBlocks,{comments});
  const zip=await JSZip.loadAsync(saved), xml=await zip.file('word/document.xml')!.async('string');
  assert.match(xml,/<w:commentRangeStart w:id="1"/); assert.match(xml,/<w:commentRangeEnd w:id="1"/);
  assert.equal((await parseDocx(saved)).comments[0]?.text,'Verify this exact phrase');
  assert.equal(await zip.file('customXml/untouched.xml')!.async('string'),'<firm>Preserve this exact private source part.</firm>');
  const deleted=executeBrowserWriterTool(editor,call('delete_comment',{id:'1'}),nums,undefined,null,access,undefined)!;
  assert.equal(deleted.mutated,true);
  const deletedZip=await JSZip.loadAsync(await saveDocx(parsed,pmDocToSavePlan(editor.getJSON() as ReturnType<typeof blocksToPmDoc>,parsed.blocks).saveBlocks,{comments}));
  assert.doesNotMatch(await deletedZip.file('word/document.xml')!.async('string'),/commentRange(?:Start|End)/);
});

test('editing and deleting a native endnote preserves rich content and unrelated footnotes after export', async () => {
  const {parsed}=await packageOf('<w:p><w:r><w:t>Original body</w:t></w:r><w:r><w:endnoteReference w:id="3"/></w:r><w:r><w:footnoteReference w:id="4"/></w:r></w:p>');
  const editor=editorFor(blocksToPmDoc(parsed.blocks));
  let endnotes:NoteInfo[]=[{id:'3',text:'First citation',richParas:[[{text:'First ',bold:true},{text:'citation',italic:true}]]}];
  const footnotes:NoteInfo[]=[{id:'4',text:'Unrelated footnote'}];
  const app:AiDocumentAccess={notes:{list:kind=>kind==='endnote'?endnotes:footnotes,insert:()=> 'not required',replace:(_kind,id,note)=>{endnotes=endnotes.map(n=>n.id===id?note:n);return null},remove:(kind,id)=>{removeNoteRefs(editor,kind,id);endnotes=endnotes.filter(n=>n.id!==id);return null},protectedMarkBlock:()=>null}};
  const edited=executeBrowserWriterTool(editor,call('edit_note',{kind:'endnote',id:'3',find:'citation',replace:'authority'}),nums,undefined,null,undefined,app)!;
  assert.equal(edited.mutated,true);
  const bytes=await saveDocx(parsed,pmDocToSavePlan(editor.getJSON() as ReturnType<typeof blocksToPmDoc>,parsed.blocks).saveBlocks,{endnotes,footnotes});
  const zip=await JSZip.loadAsync(bytes), xml=await zip.file('word/endnotes.xml')!.async('string');
  assert.match(xml,/<w:b\s*\/>/); assert.match(xml,/<w:i\s*\/>/); assert.match(xml,/>authority</);
  const reopened=await parseDocx(bytes);
  assert.equal(reopened.endnotes[0]?.text,'First authority'); assert.equal(reopened.footnotes[0]?.text,'Unrelated footnote');
  const deleted=executeBrowserWriterTool(editor,call('delete_note',{kind:'endnote',id:'3'}),nums,undefined,null,undefined,app)!;
  assert.equal(deleted.mutated,true);
  const after=await parseDocx(await saveDocx(parsed,pmDocToSavePlan(editor.getJSON() as ReturnType<typeof blocksToPmDoc>,parsed.blocks).saveBlocks,{endnotes,footnotes}));
  assert.equal(after.endnotes.length,0); assert.equal(after.footnotes[0]?.text,'Unrelated footnote');
  assert.doesNotMatch(after.internal.documentXml,/<w:endnoteReference/); assert.match(after.internal.documentXml,/<w:footnoteReference/);
});

test('selection replacement retains native comment anchors and insertion at document start can be tracked', async () => {
  const editor=editorFor({type:'doc',content:[{type:'docParagraph',content:[{type:'text',text:'Before selected after',marks:[{type:'comment',attrs:{ids:'7'}}]}]}]});
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc,8,16)));
  const changed=executeBrowserWriterTool(editor,call('replace_selection',{html:'revised'}),nums,undefined,{scope:getSelectionScope(editor),doc:editor.state.doc},undefined,undefined)!;
  assert.equal(changed.isError,undefined);assert.equal(editor.state.doc.textContent,'Before revised after');
  assert.ok(editor.state.doc.child(0).firstChild?.marks.some(mark=>mark.type.name==='comment'&&mark.attrs.ids==='7'));
  const inserted=executeBrowserWriterTool(editor,call('write_document',{html:'New introduction',afterBlockIndex:-1}),nums,{author:'Synthetic agent'},null,undefined,undefined)!;
  assert.equal(inserted.isError,undefined);assert.equal(editor.state.doc.child(0).textContent,'New introduction');
  assert.ok(editor.state.doc.child(0).firstChild?.marks.some(mark=>mark.type.name==='ins'));
});

test('pending style preview and native save resolve the same inheritance while preserving source and rejecting cycles', async () => {
  const {parsed}=await packageOf();const before=Buffer.from(parsed.internal.originalBytes);
  const pending={Normal:{styleId:'Normal',rPr:{color:'AABBCC'}},Callout:{styleId:'Callout',basedOn:'Normal',pPr:{outlineLevel:2}}};
  const preview=await previewStyleDefinitions(parsed,pending);
  const saved=await saveDocx(parsed,pmDocToSavePlan(blocksToPmDoc(parsed.blocks),parsed.blocks).saveBlocks,{styleUpserts:Object.values(pending)});
  const reopened=await parseDocx(saved);
  assert.deepEqual(preview.styles.get('Callout'),reopened.styles.get('Callout'));
  assert.equal(preview.styles.get('Callout')?.display?.color,'AABBCC');assert.equal(preview.styles.get('Callout')?.headingLevel,2);
  assert.deepEqual(Buffer.from(parsed.internal.originalBytes),before);assert.equal(parsed.styles.get('Normal')?.display?.color,'102030');
  assert.ok('error' in resolveStyleDefinition({styleId:'Normal',basedOn:'Callout'},[{styleId:'Normal',name:'Normal',type:'paragraph'},{styleId:'Callout',name:'Callout',type:'paragraph',basedOn:'Normal'}]));
  assert.equal(pendingHeadingLevel('Callout',id=>id==='Callout'?{styleId:id,pPr:{outlineLevel:null}}:undefined,id=>preview.styles.get(id)),undefined);
  const single=mergeStylesXml(`<w:styles xmlns:w="${W}"><w:style w:type='paragraph' w:styleId='Normal'><w:name w:val="Normal"/></w:style></w:styles>`,[{styleId:'Normal',rPr:{color:'00FF00'}}]);
  assert.equal((single.match(/<w:style\b/g)??[]).length,1);assert.match(single,/00FF00/);
});

test('page context bounds model payload and retains multi-page block boundaries',()=>{
  const blocks=Array.from({length:250},(_,blockIndex)=>({blockIndex,firstPage:2,lastPage:blockIndex===0?3:2}));
  const page=writerPageContext(5,2,blocks)!;assert.equal(page.blocks.length,200);assert.equal(page.truncated,true);
  const next=writerPageContext(5,2,blocks,3)!;assert.deepEqual(next.blocks,[blocks[0]]);assert.equal(next.truncated,false);
  assert.equal(writerPageContext(5,2,blocks,6),null);
});

test('explicit body replacement does not inherit old paragraph page breaks or source anchors',async()=>{
  const {parsed}=await packageOf('<w:p><w:r><w:t>Old first</w:t></w:r></w:p><w:p><w:pPr><w:pageBreakBefore/><w:ind w:left="1440"/></w:pPr><w:r><w:t>Old second page</w:t></w:r></w:p>');
  const editor=editorFor(blocksToPmDoc(parsed.blocks));
  const outcome=executeBrowserWriterTool(editor,call('write_document',{replace:true,html:'Fresh first\n\nFresh second\n\nFresh third'}),nums,undefined,null,undefined,undefined)!;
  assert.equal(outcome.mutated,true);
  const bytes=await saveDocx(parsed,pmDocToSavePlan(editor.getJSON() as ReturnType<typeof blocksToPmDoc>,parsed.blocks).saveBlocks);
  const xml=await(await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string');
  assert.ok(!xml.includes('pageBreakBefore')); assert.ok(!xml.includes('w:ind')); assert.ok(!xml.includes('Old second'));
  assert.match(xml,/<w:pgSz w:w="12240" w:h="15840"/);
  assert.match(xml,/Fresh third/);
});

test('native drawing lengths reject overflow and nonpositive picture sizes without silent clamping',()=>{
  assert.equal(parseEmu(Number.MAX_VALUE,'in'),undefined);
  assert.equal(parseEmu('9'.repeat(400)+'in'),undefined);
  assert.equal(parseEmu('-1in'),-914400); // negative offsets remain legitimate
  const input={base64:'synthetic',mime:'image/png' as const,naturalWidth:96,naturalHeight:96};
  for(const width of ['-1in','0pt',Number.MAX_VALUE]) assert.ok('error' in pictureNode({...input,width}));
  assert.ok('error' in textBoxNode({text:'box',width:'9'.repeat(400)+'in',height:'1in',x:'0pt',y:'0pt'}));
});


test('a focused Writer edit preserves 24 native tables and a real editable chart with embedded XLSX', async()=>{
  const tables=Array.from({length:24},(_,i)=>`<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:shd w:fill="172E4C"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Metric ${i+1}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>25</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`).join('');
  const {parsed}=await packageOf('<w:p><w:r><w:t>Before selected after</w:t></w:r></w:p>'+tables);
  const baseline=await saveDocx(parsed,[...pmDocToSavePlan(blocksToPmDoc(parsed.blocks),parsed.blocks).saveBlocks,{kind:'chart',chart:{kind:'bar',title:'Editable earnings trend',categories:['Q1','Q2'],series:[{name:'Synthetic amounts',values:[12,25]}]}}]);
  const original=await parseDocx(baseline), editor=editorFor(blocksToPmDoc(original.blocks));
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc,8,16)));
  const changed=executeBrowserWriterTool(editor,call('replace_selection',{html:'verified'}),nums,undefined,{scope:getSelectionScope(editor),doc:editor.state.doc},undefined,undefined)!;
  assert.equal(changed.mutated,true);
  const saved=await saveDocx(original,pmDocToSavePlan(editor.getJSON() as ReturnType<typeof blocksToPmDoc>,original.blocks).saveBlocks);
  const reopened=await parseDocx(saved);
  assert.equal(reopened.blocks.filter(block=>block.type==='table').length,24);
  assert.equal(reopened.blocks.find(block=>block.chartDisplay)?.chartDisplay?.title,'Editable earnings trend');
  assert.deepEqual(reopened.blocks.filter(block=>block.type==='table').map(block=>block.originalXml),original.blocks.filter(block=>block.type==='table').map(block=>block.originalXml));
  const beforeZip=await JSZip.loadAsync(baseline), afterZip=await JSZip.loadAsync(saved);
  const parts=Object.keys(beforeZip.files).filter(path=>/^word\/(?:charts|embeddings)\//.test(path)&&!beforeZip.files[path]!.dir);
  assert.ok(parts.some(path=>path.endsWith('.xlsx')));assert.ok(parts.some(path=>/chart\d+\.xml$/.test(path)));
  for(const path of parts) assert.deepEqual(await afterZip.file(path)!.async('uint8array'),await beforeZip.file(path)!.async('uint8array'),path);
});

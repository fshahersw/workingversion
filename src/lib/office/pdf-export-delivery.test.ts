import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPdfExportDelivery} from '../../office/pdf/export-delivery';
import type {OfficeDocSummary} from './types';

test('PDF derivative retries reuse saved receipts and offer the authoritative revision', async () => {
  let creates=0; const offers: unknown[][]=[];
  const deliver=createPdfExportDelivery(async name=>({draftId:'synthetic-export',version:1,name,kind:'pdf'} as OfficeDocSummary),(...args)=>offers.push(args),()=>true);
  const first=await deliver(new Uint8Array([1]),'extract.pdf');
  assert.equal(first.saved,true); assert.deepEqual(offers,[['synthetic-export',1,'extract.pdf']]);
  const retry=createPdfExportDelivery(async name=>{creates++;return {draftId:'same-receipt',version:2,name,kind:'pdf'} as OfficeDocSummary;},(...args)=>offers.push(args),()=>true);
  assert.deepEqual(await retry(new Uint8Array([2]),'part.pdf'),await retry(new Uint8Array([2]),'part.pdf'));
  assert.equal(creates,1);
  await retry(new Uint8Array([3]),'part.pdf'); assert.equal(creates,2);
});

test('PDF creation failure remains retryable and never offers a nonexistent file', async () => {
  let creates=0,offers=0;
  const deliver=createPdfExportDelivery(async name=>{if(++creates===1)throw new Error('storage failed');return {draftId:'saved',version:1,name} as OfficeDocSummary;},()=>offers++,()=>true);
  await assert.rejects(deliver(new Uint8Array([1]),'part.pdf'),/storage failed/); assert.equal(offers,0);
  await deliver(new Uint8Array([1]),'part.pdf'); assert.equal(creates,2); assert.equal(offers,1);
});

test('PDF cancellation after creation keeps a retry receipt without starting a stale download', async () => {
  const controller=new AbortController();let creates=0,offers=0;
  const deliver=createPdfExportDelivery(async name=>{creates++;controller.abort();return {draftId:'saved',version:1,name} as OfficeDocSummary;},()=>offers++,()=>true);
  await deliver(new Uint8Array([1]),'part.pdf',controller.signal); assert.equal(offers,0);
  await deliver(new Uint8Array([1]),'part.pdf'); assert.equal(creates,1); assert.equal(offers,1);
});

test('PDF closed workspace never creates or offers exports', async () => {
  const deliver=createPdfExportDelivery(async()=>{throw new Error('must not create');},()=>{throw new Error('must not offer');},()=>false);
  await assert.rejects(deliver(new Uint8Array([1]),'part.pdf'),/workspace closed/);
});

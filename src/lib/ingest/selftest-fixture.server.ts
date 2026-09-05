// Generated from samples/ingest/golden — the golden contract-v1 bundle,
// embedded so the self-test runs in the deployed worker with no filesystem.
// Regenerate with: python3 scripts/pipeline/make_fixture.py

export const FIXTURE_MANIFEST = {
  "contract_version": "1.0",
  "idempotency_key": "golden-sample-2024-06-30-0001",
  "matter": {
    "slug": "example-mdl-3199",
    "short_name": "Example Products Liability",
    "caption": "In re: Example Products Liability Litigation",
    "docket_number": "1:24-md-03199",
    "court": "District of Example",
    "mdl_number": "3199",
    "judge": "Hon. A. Judge",
    "date_filed": "2024-02-27",
    "courtlistener_docket_id": 68000001,
    "stage": "pretrial"
  },
  "dockets": [
    {
      "source": "main",
      "docket_number": "1:24-md-03199",
      "courtlistener_docket_id": 68000001
    },
    {
      "source": "jpml",
      "docket_number": "MDL No. 3199",
      "courtlistener_docket_id": 68000002
    }
  ],
  "batch": {
    "mode": "full",
    "filename_inference": false,
    "submitted_by": "etl@seegerweiss.example"
  },
  "files": [
    {
      "file_name": "main-00001-000.pdf",
      "size_bytes": 1137
    },
    {
      "file_name": "main-00001-001.pdf",
      "size_bytes": 601
    },
    {
      "file_name": "main-00014-000.pdf",
      "size_bytes": 2071
    },
    {
      "file_name": "jpml-00003-000.pdf",
      "size_bytes": 884
    }
  ],
  "totals": {
    "document_slots": 7,
    "pdf_files": 4,
    "total_pages": 12,
    "total_bytes": 4693
  }
} as const;

export const FIXTURE_DOCKET_CSV = "record_id,docket_source,entry_number,entry_label,attachment_number,filed_date,description,document_title,doc_type,availability,file_name,page_count,size_bytes,sha256,is_sealed,recap_pdf_url,pacer_pdf_url,pacer_price_usd\nsw-0001,main,1,1,0,2024-03-11,\"COMPLAINT against all Defendants, filed by Plaintiffs. (Attachments: # 1 Civil Cover Sheet)\",Complaint,pleading,free_pdf,main-00001-000.pdf,3,1137,0a07ffb5059e877c43804dbc77fbdc038a81968622d1273858393a8ba5bb9635,,https://storage.courtlistener.com/recap/gov.uscourts.example.1/gov.uscourts.example.1.1.0.pdf,,\nsw-0002,main,1,1-1,1,2024-03-11,Civil Cover Sheet,Civil Cover Sheet,exhibit,free_pdf,main-00001-001.pdf,1,601,aec72056fea27a0f6ffd7a485fa591317509d227c315d6995d571bd1fda3314e,,,,\nsw-0003,main,7,7,0,2024-04-02,TEXT ORDER granting the parties' joint request for an initial conference. No PDF issued.,Text Order,order,text_only,,,,,,,,\nsw-0004,main,12,12,0,2024-04-18,SEALED MOTION for protective order.,Sealed Motion,motion,sealed,,,,,true,,,\nsw-0005,main,14,14,0,2024-05-06,\"CASE MANAGEMENT ORDER NO. 1 governing leadership, service, and preservation.\",Case Management Order No. 1,case_management,free_pdf,main-00014-000.pdf,6,2071,e0a8e91e817a1490bd7ac9549d90ffe1cc0e976ce6000d4388a80110b43e9a9c,,,,\nsw-0006,main,22,22,0,2024-06-20,TRANSCRIPT of status conference held 06/12/2024. Available from PACER only.,Status Conference Transcript,transcript,pacer_link,,,,,,,https://ecf.example.uscourts.gov/doc1/000000000,3.00\nsw-0007,jpml,3,JPML 3,0,2024-02-27,TRANSFER ORDER centralizing 14 actions in the District of Example. (MDL No. 3199),JPML Transfer Order,mdl,free_pdf,jpml-00003-000.pdf,2,884,01e8a98abc8046d5cd423bbf27e9a4550980c0979d4ae636ff24c2415697866e,,,,\n";

export const FIXTURE_PARTIES_CSV = "party_role,party_name,representation,attorney_name,attorney_designations,attorney_email,firm_name,firm_address\nPlaintiff,Jane Doe,represented by,Christopher A. Seeger,LEAD ATTORNEY,cseeger@example.com,Seeger Weiss LLP,\"55 Challenger Road, Ridgefield Park, NJ 07660\"\nDefendant,\"Example Pharma, Inc.\",represented by,Pat Counsel,,pcounsel@example.com,Defense Firm LLP,\"1 Market Street, San Francisco, CA 94105\"\n";

/** base64-encoded PDFs, keyed by the exact declared file_name. */
export const FIXTURE_PDFS: Record<string, string> = {
  "jpml-00003-000.pdf": "JVBERi0xLjcKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFs0IDAgUiA1IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago0IDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgNjEyIDc5Ml0gL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgMyAwIFIgPj4gPj4gL0NvbnRlbnRzIDYgMCBSID4+CmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgNjEyIDc5Ml0gL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgMyAwIFIgPj4gPj4gL0NvbnRlbnRzIDcgMCBSID4+CmVuZG9iago2IDAgb2JqCjw8IC9MZW5ndGggNTkgPj4Kc3RyZWFtCkJUIC9GMSAxNCBUZiA3MiA3MDAgVGQgKEpQTUwgVHJhbnNmZXIgT3JkZXIgLSBwYWdlIDEpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNyAwIG9iago8PCAvTGVuZ3RoIDU5ID4+CnN0cmVhbQpCVCAvRjEgMTQgVGYgNzIgNzAwIFRkIChKUE1MIFRyYW5zZmVyIE9yZGVyIC0gcGFnZSAyKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMjEgMDAwMDAgbiAKMDAwMDAwMDE5MSAwMDAwMCBuIAowMDAwMDAwMzE3IDAwMDAwIG4gCjAwMDAwMDA0NDMgMDAwMDAgbiAKMDAwMDAwMDU1MiAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDggL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjY2MQolJUVPRgo=",
  "main-00001-000.pdf": "JVBERi0xLjcKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFs0IDAgUiA1IDAgUiA2IDAgUl0gL0NvdW50IDMgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago0IDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgNjEyIDc5Ml0gL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgMyAwIFIgPj4gPj4gL0NvbnRlbnRzIDcgMCBSID4+CmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgNjEyIDc5Ml0gL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgMyAwIFIgPj4gPj4gL0NvbnRlbnRzIDggMCBSID4+CmVuZG9iago2IDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgNjEyIDc5Ml0gL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgMyAwIFIgPj4gPj4gL0NvbnRlbnRzIDkgMCBSID4+CmVuZG9iago3IDAgb2JqCjw8IC9MZW5ndGggNDkgPj4Kc3RyZWFtCkJUIC9GMSAxNCBUZiA3MiA3MDAgVGQgKENvbXBsYWludCAtIHBhZ2UgMSkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago4IDAgb2JqCjw8IC9MZW5ndGggNDkgPj4Kc3RyZWFtCkJUIC9GMSAxNCBUZiA3MiA3MDAgVGQgKENvbXBsYWludCAtIHBhZ2UgMikgVGogRVQKZW5kc3RyZWFtCmVuZG9iago5IDAgb2JqCjw8IC9MZW5ndGggNDkgPj4Kc3RyZWFtCkJUIC9GMSAxNCBUZiA3MiA3MDAgVGQgKENvbXBsYWludCAtIHBhZ2UgMykgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgMTAKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDEyNyAwMDAwMCBuIAowMDAwMDAwMTk3IDAwMDAwIG4gCjAwMDAwMDAzMjMgMDAwMDAgbiAKMDAwMDAwMDQ0OSAwMDAwMCBuIAowMDAwMDAwNTc1IDAwMDAwIG4gCjAwMDAwMDA2NzQgMDAwMDAgbiAKMDAwMDAwMDc3MyAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDEwIC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo4NzIKJSVFT0YK",
  "main-00001-001.pdf": "JVBERi0xLjcKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFs0IDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago0IDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgNjEyIDc5Ml0gL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgMyAwIFIgPj4gPj4gL0NvbnRlbnRzIDUgMCBSID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNTcgPj4Kc3RyZWFtCkJUIC9GMSAxNCBUZiA3MiA3MDAgVGQgKENpdmlsIENvdmVyIFNoZWV0IC0gcGFnZSAxKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDE4NSAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDE4CiUlRU9GCg==",
  "main-00014-000.pdf": "JVBERi0xLjcKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFs0IDAgUiA1IDAgUiA2IDAgUiA3IDAgUiA4IDAgUiA5IDAgUl0gL0NvdW50IDYgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago0IDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgNjEyIDc5Ml0gL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgMyAwIFIgPj4gPj4gL0NvbnRlbnRzIDEwIDAgUiA+PgplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDYxMiA3OTJdIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDMgMCBSID4+ID4+IC9Db250ZW50cyAxMSAwIFIgPj4KZW5kb2JqCjYgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSAzIDAgUiA+PiA+PiAvQ29udGVudHMgMTIgMCBSID4+CmVuZG9iago3IDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgNjEyIDc5Ml0gL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgMyAwIFIgPj4gPj4gL0NvbnRlbnRzIDEzIDAgUiA+PgplbmRvYmoKOCAwIG9iago8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDYxMiA3OTJdIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDMgMCBSID4+ID4+IC9Db250ZW50cyAxNCAwIFIgPj4KZW5kb2JqCjkgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSAzIDAgUiA+PiA+PiAvQ29udGVudHMgMTUgMCBSID4+CmVuZG9iagoxMCAwIG9iago8PCAvTGVuZ3RoIDY3ID4+CnN0cmVhbQpCVCAvRjEgMTQgVGYgNzIgNzAwIFRkIChDYXNlIE1hbmFnZW1lbnQgT3JkZXIgTm8uIDEgLSBwYWdlIDEpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKMTEgMCBvYmoKPDwgL0xlbmd0aCA2NyA+PgpzdHJlYW0KQlQgL0YxIDE0IFRmIDcyIDcwMCBUZCAoQ2FzZSBNYW5hZ2VtZW50IE9yZGVyIE5vLiAxIC0gcGFnZSAyKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjEyIDAgb2JqCjw8IC9MZW5ndGggNjcgPj4Kc3RyZWFtCkJUIC9GMSAxNCBUZiA3MiA3MDAgVGQgKENhc2UgTWFuYWdlbWVudCBPcmRlciBOby4gMSAtIHBhZ2UgMykgVGogRVQKZW5kc3RyZWFtCmVuZG9iagoxMyAwIG9iago8PCAvTGVuZ3RoIDY3ID4+CnN0cmVhbQpCVCAvRjEgMTQgVGYgNzIgNzAwIFRkIChDYXNlIE1hbmFnZW1lbnQgT3JkZXIgTm8uIDEgLSBwYWdlIDQpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKMTQgMCBvYmoKPDwgL0xlbmd0aCA2NyA+PgpzdHJlYW0KQlQgL0YxIDE0IFRmIDcyIDcwMCBUZCAoQ2FzZSBNYW5hZ2VtZW50IE9yZGVyIE5vLiAxIC0gcGFnZSA1KSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjE1IDAgb2JqCjw8IC9MZW5ndGggNjcgPj4Kc3RyZWFtCkJUIC9GMSAxNCBUZiA3MiA3MDAgVGQgKENhc2UgTWFuYWdlbWVudCBPcmRlciBOby4gMSAtIHBhZ2UgNikgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgMTYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDE0NSAwMDAwMCBuIAowMDAwMDAwMjE1IDAwMDAwIG4gCjAwMDAwMDAzNDIgMDAwMDAgbiAKMDAwMDAwMDQ2OSAwMDAwMCBuIAowMDAwMDAwNTk2IDAwMDAwIG4gCjAwMDAwMDA3MjMgMDAwMDAgbiAKMDAwMDAwMDg1MCAwMDAwMCBuIAowMDAwMDAwOTc3IDAwMDAwIG4gCjAwMDAwMDEwOTUgMDAwMDAgbiAKMDAwMDAwMTIxMyAwMDAwMCBuIAowMDAwMDAxMzMxIDAwMDAwIG4gCjAwMDAwMDE0NDkgMDAwMDAgbiAKMDAwMDAwMTU2NyAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDE2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgoxNjg1CiUlRU9GCg==",
};

export function fixtureBytes(name: string): Uint8Array {
  const b64 = FIXTURE_PDFS[name];
  if (!b64) throw new Error(`fixture missing ${name}`);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

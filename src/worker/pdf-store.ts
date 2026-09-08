import { PDF_CHUNK_BYTES, type SourceChunk, type SourceDocument } from "../shared/import-history";

/** Original bytes belong to the tenant's Vault. No whole-file buffers or public URLs. */
export class PdfStore {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS pdf_sources (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pdf_chunks (id TEXT NOT NULL, part INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(id,part));`);
  }
  /** Caller validates each chunk before entering the transfer's SQLite transaction. */
  stage(c: SourceChunk, bytes: Uint8Array) {
    const previous=this.sql.exec<{bytes:number}>("SELECT bytes FROM pdf_sources WHERE id=?",c.id).toArray()[0];
    if(previous && previous.bytes!==c.totalBytes)throw new Error("PDF source length changed during transfer");
    const part=this.sql.exec<{sha256:string}>("SELECT sha256 FROM pdf_chunks WHERE id=? AND part=?",c.id,c.part).toArray()[0];
    if(part && part.sha256!==c.sha256)throw new Error("PDF source chunk changed during transfer");
    this.sql.exec("INSERT OR IGNORE INTO pdf_sources(id,bytes) VALUES(?,?)",c.id,c.totalBytes);
    if(!part)this.sql.exec("INSERT INTO pdf_chunks(id,part,sha256,data) VALUES(?,?,?,?)",c.id,c.part,c.sha256,bytes.buffer);
  }
  async verify(source: SourceDocument) {
    const meta=this.sql.exec<{bytes:number;verified:number}>("SELECT bytes,verified FROM pdf_sources WHERE id=?",source.sha256).toArray()[0];
    if(!source.pdf || !meta || meta.bytes!==source.pdf.byteLength)throw new Error("Original PDF has not been transferred completely");
    if(meta.verified)return;
    const digest=new crypto.DigestStream("SHA-256"),writer=digest.getWriter();
    try {
      for(let part=0;part<Math.ceil(meta.bytes/PDF_CHUNK_BYTES);part++) {
        const row=this.sql.exec<{data:ArrayBuffer}>("SELECT data FROM pdf_chunks WHERE id=? AND part=?",source.sha256,part).toArray()[0];
        if(!row || row.data.byteLength!==Math.min(PDF_CHUNK_BYTES,meta.bytes-part*PDF_CHUNK_BYTES))throw new Error("Original PDF has missing source chunks");
        await writer.write(row.data);
      }
      await writer.close();
      const actual=[...new Uint8Array(await digest.digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
      if(actual!==source.sha256)throw new Error("Original PDF checksum mismatch; no record was filed");
      this.sql.exec("UPDATE pdf_sources SET verified=1 WHERE id=?",source.sha256);
    } catch(e) { await writer.abort().catch(()=>{}); await digest.digest.catch(()=>{}); throw e; }
  }
  async response(source: SourceDocument, range: string | null, inline: boolean): Promise<Response> {
    try {await this.verify(source);} catch(e) {return new Response((e as Error).message,{status:409});}
    const size=source.pdf!.byteLength;
    let start=0,end=size-1;
    const headers=new Headers({"content-type":"application/pdf","cache-control":"no-store","accept-ranges":"bytes",
      "content-disposition":`${inline?"inline":"attachment"}; filename="source-${source.sha256.slice(0,12)}.pdf"`,
      "x-content-type-options":"nosniff","x-frame-options":"SAMEORIGIN","content-security-policy":"sandbox; frame-ancestors 'self'"});
    if(range) {
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(match && (match[1] || match[2])) {
        if(!match[1])start=Math.max(0,size-Number(match[2]));
        else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
      } else start=size;
      if(!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start>=size || start<0 || end<start){headers.set("content-range",`bytes */${size}`);return new Response(null,{status:416,headers});}
      headers.set("content-range",`bytes ${start}-${end}/${size}`);
    }
    headers.set("content-length",String(end-start+1));
    let offset=start;
    const body=new ReadableStream<Uint8Array>({pull:controller=>{
      if(offset>end){controller.close();return;}
      const part=Math.floor(offset/PDF_CHUNK_BYTES);
      const row=this.sql.exec<{data:ArrayBuffer}>("SELECT data FROM pdf_chunks WHERE id=? AND part=?",source.sha256,part).toArray()[0];
      if(!row){controller.error(new Error("Original PDF chunk is unavailable"));return;}
      const bytes=new Uint8Array(row.data),from=offset-part*PDF_CHUNK_BYTES,to=Math.min(bytes.byteLength,end-part*PDF_CHUNK_BYTES+1);
      controller.enqueue(bytes.subarray(from,to));offset+=to-from;
    }});
    return new Response(body,{status:range?206:200,headers});
  }
}

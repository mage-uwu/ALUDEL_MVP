import {useEffect,useRef,useState} from "react";
import type {PDFDocumentProxy,PDFDocumentLoadingTask,RenderTask} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

/** Render original PDF bytes. No forms, field mapping or active document scripts. */
export function PdfViewer({url}:{url:string}) {
  const [doc,setDoc]=useState<PDFDocumentProxy|null>(null),[page,setPage]=useState(1),[width,setWidth]=useState(0),[zoom,setZoom]=useState(1);
  const [error,setError]=useState(""),[busy,setBusy]=useState(true),container=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    let stopped=false,task:PDFDocumentLoadingTask|undefined;setDoc(null);setPage(1);setError("");setBusy(true);
    void import("pdfjs-dist/legacy/build/pdf.mjs").then(pdf=>{
      if(stopped)return;pdf.GlobalWorkerOptions.workerSrc=workerUrl;
      task=pdf.getDocument({url,withCredentials:true,cMapUrl:"/pdfjs/cmaps/",cMapPacked:true,standardFontDataUrl:"/pdfjs/standard_fonts/",wasmUrl:"/pdfjs/wasm/"});
      return task.promise.then(value=>{if(!stopped)setDoc(value);});
    }).catch(e=>{if(!stopped){setError(e?.name==="PasswordException"?"This PDF needs a password. Use Open PDF to unlock the original.":"This PDF could not be displayed. You can open or download the original.");setBusy(false);}});
    return()=>{stopped=true;void task?.destroy();};
  },[url]);
  useEffect(()=>{
    const target=container.current;if(!target)return;
    const resize=new ResizeObserver(([entry])=>setWidth(Math.floor(entry!.contentRect.width)));
    resize.observe(target);return()=>resize.disconnect();
  },[]);
  useEffect(()=>{
    if(!doc || !width || !canvas.current)return;
    let stopped=false,task:RenderTask|undefined;setBusy(true);setError("");
    canvas.current.width=0;canvas.current.height=0;
    void doc.getPage(page).then(pdfPage=>{
      if(stopped)return;
      const target=canvas.current!,natural=pdfPage.getViewport({scale:1}),scale=width/natural.width*zoom;
      // Bound raster memory even for poster-size or adversarial page dimensions.
      const pixels=Math.min(window.devicePixelRatio||1,2,Math.sqrt(8_000_000/(natural.width*natural.height*scale*scale)));
      const viewport=pdfPage.getViewport({scale:scale*pixels});
      target.width=Math.max(1,Math.floor(viewport.width));target.height=Math.max(1,Math.floor(viewport.height));
      target.style.width=`${width*zoom}px`;target.style.height=`${natural.height*scale}px`;
      task=pdfPage.render({canvas:target,viewport});return task.promise;
    }).then(()=>{if(!stopped)setBusy(false);}).catch(e=>{if(!stopped && e?.name!=="RenderingCancelledException"){setError("This page could not be displayed. Open or download the original PDF.");setBusy(false);}});
    return()=>{stopped=true;task?.cancel();};
  },[doc,page,width,zoom]);
  return <div className="pdf-viewer" ref={container}>
    <div className="pdf-controls">
      <button aria-label="Previous PDF page" disabled={!doc||page===1} onClick={()=>setPage(p=>p-1)}>Previous</button>
      <span aria-live="polite">{doc?`Page ${page} of ${doc.numPages}`:error?"PDF preview unavailable":"Loading PDF…"}</span>
      <button aria-label="Next PDF page" disabled={!doc||page===doc.numPages} onClick={()=>setPage(p=>p+1)}>Next</button>
      <label>Zoom<select aria-label="PDF zoom" value={zoom} onChange={e=>setZoom(Number(e.target.value))}><option value={1}>Fit width</option><option value={1.5}>150%</option><option value={2}>200%</option></select></label>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="pdf-page" aria-busy={busy}><canvas ref={canvas} role="img" aria-label={`Original PDF page ${page}`} /></div>
  </div>;
}

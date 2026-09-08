import {cp,mkdir} from "node:fs/promises";
// Fonts, CMaps and decoders stay on our origin, with the same pinned PDF.js build.
for(const name of ["cmaps","standard_fonts","wasm"]){
  const target=`dist/client/pdfjs/${name}`;
  await mkdir(target,{recursive:true});
  await cp(`node_modules/pdfjs-dist/${name}`,target,{recursive:true});
}

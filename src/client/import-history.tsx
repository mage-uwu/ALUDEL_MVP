import { sourceCsvRows, type ImportHistory } from "../shared/import-history";

/** React renders source data as text. Embedded HTML, scripts and links never run. */
export function ImportedHistory({ history, download }: { history: ImportHistory; download?: string }) {
  const source = history.sourceDocument;
  const rows = source && ["text/csv", "text/tab-separated-values"].includes(source.mediaType)
    ? sourceCsvRows(source.content, source.delimiter ?? (source.mediaType === "text/csv" ? "," : "\t")) : null;
  return <section className="card glass-frosted history-record" aria-label="Imported historical content">
    <div className="history-heading"><h2>{source ? "Original record" : "Received data"}</h2>
      {source && download && <a href={download} download>Download source</a>}
    </div>
    {!source && <p className="template-meta">The original source was not supplied. These are the values received during import.</p>}
    {rows?.length === 2 && rows[0]!.length === rows[1]!.length ? <table className="history-fields"><tbody>
      {rows[0]!.map((label, i) => <tr key={i}><th scope="row">{label}</th><td>{rows[1]![i]}</td></tr>)}
    </tbody></table> : <pre className="history-text">{source?.content ?? JSON.stringify(history.receivedValues, null, 2)}</pre>}
    {source && rows && <details><summary>Source text</summary><pre className="history-text">{source.content}</pre></details>}
  </section>;
}

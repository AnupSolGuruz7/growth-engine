import path from 'node:path';

/**
 * Local, free text embeddings (no API key, nothing leaves the machine): BAAI bge-small-en-v1.5,
 * 384 dimensions, run on CPU through transformers.js / onnxruntime. The model (~34 MB, int8) is
 * downloaded from the Hugging Face hub on first use and cached on disk.
 */
export const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';
export const EMBEDDING_DIMS = 384;
/** bge models retrieve best when the query (not the passage) carries this instruction prefix. */
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

type Extractor = (texts: string[], opts: { pooling: 'cls'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

let loading: Promise<Extractor> | null = null;

function cacheDir(): string {
  return process.env.EMBEDDING_CACHE_DIR || path.resolve(__dirname, '../../../.cache/models');
}

async function extractor(): Promise<Extractor> {
  loading ??= (async () => {
    const t = await import('@huggingface/transformers');
    t.env.cacheDir = cacheDir();
    const fe = await t.pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8' });
    return fe as unknown as Extractor;
  })().catch((e) => {
    loading = null; // let a later call retry (e.g. the first download failed offline)
    throw e;
  });
  return loading;
}

/** Embeds passages (document chunks) in batches. Vectors are L2-normalised: cosine = dot product. */
export async function embedPassages(texts: string[], batchSize = 16): Promise<number[][]> {
  const fe = await extractor();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const res = await fe(texts.slice(i, i + batchSize), { pooling: 'cls', normalize: true });
    out.push(...res.tolist());
  }
  return out;
}

export async function embedQuery(text: string): Promise<number[]> {
  const fe = await extractor();
  const res = await fe([QUERY_PREFIX + text], { pooling: 'cls', normalize: true });
  return res.tolist()[0]!;
}

/** pgvector text literal, e.g. "[0.1,0.2,...]". */
export const toVectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : '0')).join(',')}]`;

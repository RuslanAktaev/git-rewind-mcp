/** Векторы через ollama. Модель локальная, наружу ничего не уходит. */

/**
 * Чистит заголовок от служебного мусора: префикса задачи, ссылок на трекер,
 * упоминаний людей. Проверено на живых данных — без этого в вектор попадает
 * не смысл, а идентификаторы.
 */
export function cleanText(title: string, description = ''): string {
  const clean = (t: string) =>
    t
      .replace(/^[0-9a-z]{7,12}:?\s+/, '')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/@[\w.-]+/g, ' ')
      .replace(/\b(refs?|fyi)\b:?/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.,:-]+|[.,:-]+$/g, '');

  const head = clean(title);
  const tail = clean(description);
  return tail.length > 15 ? `${head}. ${tail.slice(0, 300)}` : head;
}

export class Embedder {
  constructor(
    private readonly url: string,
    private readonly model: string
  ) {}

  async embed(text: string): Promise<Float32Array> {
    let response: Response;
    try {
      response = await fetch(`${this.url}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: AbortSignal.timeout(120_000)
      });
    } catch {
      throw new Error(
        `ollama is not answering at ${this.url} — start it with "ollama serve", ` +
          `or point OLLAMA_URL elsewhere`
      );
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `ollama refused the request (${response.status}): ${body.slice(0, 200)}. ` +
          `If the model is missing, run "ollama pull ${this.model}"`
      );
    }
    const { embedding } = (await response.json()) as { embedding: number[] };
    return Float32Array.from(embedding);
  }

  /** Считает пачку, держа несколько запросов в полёте: ollama справляется. */
  async embedMany(texts: string[], parallel = 4): Promise<Float32Array[]> {
    const out = new Array<Float32Array>(texts.length);
    let next = 0;
    const worker = async () => {
      while (next < texts.length) {
        const i = next++;
        out[i] = await this.embed(texts[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, texts.length) }, worker));
    return out;
  }
}

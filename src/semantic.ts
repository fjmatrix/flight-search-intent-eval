/**
 * Semantic comparison for locations the model could not resolve to an IATA code.
 * The only network call outside the provider adapters.
 */

import OpenAI from 'openai';

export interface GradingConfig {
    embedding_model: string;
    similarity_threshold: number;
}

/** Lazy so the SDK's missing-key throw happens at call time, not at import. */
let client: OpenAI | undefined;
const getClient = () => (client ??= new OpenAI());

function cosineSimilarity(a: number[], b: number[]): number {
    const dot = a.reduce((sum, x, i) => sum + x * b[i]!, 0);
    const magA = Math.sqrt(a.reduce((sum, x) => sum + x * x, 0));
    const magB = Math.sqrt(b.reduce((sum, x) => sum + x * x, 0));

    return dot / (magA * magB);
}

/** Embeds both names and reports whether they clear the configured threshold. */
export async function isSimilar(expected: string, actual: string, config: GradingConfig): Promise<boolean> {
    if (expected === actual) {
        return true;
    }
    const result = await getClient().embeddings.create({
        model: config.embedding_model,
        input: [expected, actual],
    });

    const score = cosineSimilarity(result.data[0]!.embedding, result.data[1]!.embedding);
    console.log(`expected:${expected} ; model output: ${actual}; cosineSimilarity:${score} `);
    return score >= config.similarity_threshold;
}

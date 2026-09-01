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

/** Case and surrounding whitespace do not distinguish two place names. */
export const normalize = (name: string) => name.trim().toLowerCase();

/**
 * Similarity of every expected name against every actual name, indexed
 * [expected][actual]. Both lists ride in one request, so the caller pays for
 * one round trip however many pairs it goes on to compare.
 */
export async function scoreNames(
    expected: string[],
    actual: string[],
    config: GradingConfig,
): Promise<number[][]> {
    const result = await getClient().embeddings.create({
        model: config.embedding_model,
        input: [...expected, ...actual].map(normalize),
    });

    // The API documents `data` as input order; `index` is what actually says so.
    const vectors = [...result.data].sort((a, b) => a.index - b.index).map((entry) => entry.embedding);
    const actualVectors = vectors.slice(expected.length);

    return vectors
        .slice(0, expected.length)
        .map((expectedVector) => actualVectors.map((v) => cosineSimilarity(expectedVector, v)));
}

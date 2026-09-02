/**
 * Semantic comparison for locations the model could not resolve to an IATA code.
 * The only network call outside the provider adapters.
 */

import OpenAI from 'openai';
import { withRetry } from './providers/retry.ts';

export interface GradingConfig {
    embedding_model: string;
    similarity_threshold: number;
}

/** The same budget the adapters use; a rate-limited embedding fails the same way. */
const MAX_ATTEMPTS = 4;

/** Lazy so the SDK's missing-key throw happens at call time, not at import. */
let client: OpenAI | undefined;
const getClient = () => (client ??= new OpenAI({ maxRetries: 0 }));

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
    const { value: result } = await withRetry(MAX_ATTEMPTS, () =>
        getClient().embeddings.create({
            model: config.embedding_model,
            input: [...expected, ...actual].map(normalize),
        }),
    );

    // The API documents `data` as input order; `index` is what actually says so.
    const vectors = [...result.data].sort((a, b) => a.index - b.index).map((entry) => entry.embedding);
    const actualVectors = vectors.slice(expected.length);

    return vectors
        .slice(0, expected.length)
        .map((expectedVector) => actualVectors.map((v) => cosineSimilarity(expectedVector, v)));
}

const { GoogleGenAI } = require('@google/genai');
const config = require('./config');
const logger = require('./utils/logger');

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

const EMBEDDING_MODEL = 'gemini-embedding-2';
const EMBEDDING_DIMENSIONS = 1536;

/**
 * Generate a 768-dimensional embedding for the given text.
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} Embedding vector
 */
async function generateEmbedding(text) {
  if (!text || text.trim().length === 0) {
    throw new Error('Cannot generate embedding for empty text');
  }

  const response = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
    config: {
      outputDimensionality: EMBEDDING_DIMENSIONS,
    },
  });

  return response.embeddings[0].values;
}

/**
 * Generate embeddings for multiple texts in batch.
 * @param {string[]} texts - Array of texts to embed
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
async function generateEmbeddings(texts) {
  const results = [];
  for (const text of texts) {
    try {
      const embedding = await generateEmbedding(text);
      results.push(embedding);
    } catch (error) {
      logger.error('Batch embedding failed for text', { error: error.message, textPreview: text.substring(0, 50) });
      results.push(null);
    }
  }
  return results;
}

module.exports = {
  generateEmbedding,
  generateEmbeddings,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
};

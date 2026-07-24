const { GoogleGenAI } = require('@google/genai');
const config = require('./config');
const { generateEmbedding } = require('./embeddings');
const { searchContext } = require('./supabase');
const logger = require('./utils/logger');

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

const GENERATION_MODEL = 'gemini-2.0-flash';
const SIMILARITY_THRESHOLD = 0.4;
const MAX_RESULTS = 8;

const SYSTEM_PROMPT = `You are PM-Insight-Hub, an AI assistant for a product management team.
You answer questions using context retrieved from Slack conversations and ClickUp tasks.

Rules:
- Base your answers ONLY on the provided context. If the context doesn't contain enough information, say so clearly.
- Cite your sources by referencing where the information came from (e.g., "According to a Slack message..." or "Based on ClickUp task...").
- Be concise and actionable. Format your responses for Slack (use *bold*, bullet points, etc.).
- If asked about task status, priorities, or assignments, reference the ClickUp metadata when available.
- Never make up information that isn't in the context.`;

/**
 * Build the context string from retrieved documents.
 * @param {Array} results - Search results from Supabase
 * @returns {string} Formatted context
 */
function buildContextString(results) {
  if (!results || results.length === 0) {
    return 'No relevant context found in the knowledge base.';
  }

  return results
    .map((r, i) => {
      const source = r.source === 'slack' ? '💬 Slack' : '📋 ClickUp';
      const meta = r.metadata || {};
      const metaStr = Object.keys(meta).length > 0 ? `\nMetadata: ${JSON.stringify(meta)}` : '';
      return `--- Context ${i + 1} [${source}] (similarity: ${r.similarity.toFixed(3)}) ---\n${r.content}${metaStr}`;
    })
    .join('\n\n');
}

/**
 * Run the full RAG pipeline: embed → search → generate.
 * @param {string} question - User's question
 * @returns {Promise<{answer: string, sources: Array}>} Answer with source references
 */
async function answerQuestion(question) {
  logger.info('RAG pipeline started', { question: question.substring(0, 100) });

  // Step 1: Embed the question
  const queryEmbedding = await generateEmbedding(question);

  // Step 2: Search for relevant context
  const results = await searchContext(queryEmbedding, SIMILARITY_THRESHOLD, MAX_RESULTS);
  logger.info(`Retrieved ${results.length} context chunks`);

  // Step 3: Build the prompt
  const contextString = buildContextString(results);
  const userPrompt = `Context:\n${contextString}\n\n---\nQuestion: ${question}`;

  // Step 4: Generate the answer
  const response = await ai.models.generateContent({
    model: GENERATION_MODEL,
    contents: userPrompt,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.3,
      maxOutputTokens: 1024,
    },
  });

  const answer = response.text || 'I was unable to generate a response. Please try again.';

  logger.info('RAG pipeline completed', { answerLength: answer.length, sourcesUsed: results.length });

  return {
    answer,
    sources: results.map((r) => ({
      source: r.source,
      externalId: r.external_id,
      similarity: r.similarity,
    })),
  };
}

module.exports = {
  answerQuestion,
};

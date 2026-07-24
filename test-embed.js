const { GoogleGenAI } = require('@google/genai');
const config = require('./src/config');
const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

async function test() {
  const res = await ai.models.embedContent({
    model: 'gemini-embedding-2',
    contents: 'Hello world',
    config: { outputDimensionality: 1536 }
  });
  console.log('Result Keys:', Object.keys(res));
  if (res.embeddings) {
    console.log('Embeddings Keys:', Object.keys(res.embeddings));
    console.log('Values length:', res.embeddings[0].values.length);
  }
}
test();

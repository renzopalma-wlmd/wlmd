const { GoogleGenAI } = require('@google/genai');
const config = require('./src/config');
const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

async function listModels() {
  try {
    const models = await ai.models.list();
    for await (const model of models) {
      if (model.name.includes('flash')) {
        console.log(model.name);
      }
    }
  } catch (error) {
    console.error(error);
  }
}

listModels();

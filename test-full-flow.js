const { generateEmbedding } = require('./src/embeddings');
const { insertContext, searchContext } = require('./src/supabase');
const { answerQuestion } = require('./src/rag');

async function runFlow() {
  try {
    console.log('1. Embedding a mock message...');
    const text = 'Project Alpha deadline has been moved to August 15th.';
    const vector = await generateEmbedding(text);
    console.log(`Generated vector of length ${vector.length}`);

    console.log('2. Saving to Supabase...');
    const saved = await insertContext({
      source: 'slack', 
      externalId: 'mock-msg-123', 
      authorId: 'U123', 
      content: text, 
      embedding: vector
    });
    console.log(saved ? 'Save successful' : 'Save failed');

    console.log('3. Asking a question (RAG)...');
    const result = await answerQuestion('When is the deadline for Project Alpha?');
    console.log('\n--- ANSWER ---');
    console.log(result.answer);
    console.log('--------------\n');
    console.log('Sources:', result.sources);

  } catch (error) {
    console.error('Error in flow:', error);
  }
}

runFlow();

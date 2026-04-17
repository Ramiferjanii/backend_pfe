const { HuggingFaceTransformersEmbeddings } = require("@langchain/community/embeddings/huggingface_transformers");
const { MemoryVectorStore } = require("@langchain/classic/vectorstores/memory");
const { ChatGroq } = require("@langchain/groq");
const { createStuffDocumentsChain } = require("@langchain/classic/chains/combine_documents");
const { createRetrievalChain } = require("@langchain/classic/chains/retrieval");
const { PromptTemplate } = require("@langchain/core/prompts");
const fs = require('fs');
const path = require('path');
const { Document } = require("@langchain/core/documents");

class RagService {
  constructor() {
    this.vectorStore = null;
    this.embeddings = new HuggingFaceTransformersEmbeddings({
      modelName: "Xenova/all-MiniLM-L6-v2",
    });
    
    this.llm = new ChatGroq({
      apiKey: process.env.GROQ_API_KEY,
      model: "llama-3.1-8b-instant",
      temperature: 0.2
    });
  }

  async initializeVectorDB() {
    try {
      const kbPath = path.join(__dirname, '..', 'data', 'knowledge_base.json');
      const data = JSON.parse(fs.readFileSync(kbPath, 'utf8'));

      const docs = data.map(item => {
        const text = item.question ? `Q: ${item.question}\nA: ${item.answer}` : JSON.stringify(item);
        return new Document({
          pageContent: text,
          metadata: { source: "knowledge_base" }
        });
      });

      this.vectorStore = await MemoryVectorStore.fromDocuments(
        docs,
        this.embeddings
      );
      
      console.log("Vector DB initialized successfully in memory with knowledge base items!");
    } catch (error) {
      console.error("Error initializing Vector DB:", error.message);
    }
  }

  async getVectorStore() {
    if (!this.vectorStore) {
        await this.initializeVectorDB();
    }
    return this.vectorStore;
  }

  async handleChatQuery(query) {
    try {
      const store = await this.getVectorStore();
      
      if (!store) {
        return "I'm sorry, I'm having trouble accessing my knowledge base right now. Please try again later or contact support.";
      }

      const retriever = store.asRetriever(3);

      const promptTemplate = `
      You are a helpful AI customer support agent for our e-commerce optimization platform. 
      Use the following context to answer the user's question accurately and politely. 
      If you don't know the answer based on the context, politely let the user know and encourage them to contact support.
      
      Context: {context}
      
      Question: {input}
      
      Helpful Answer:`;

      const prompt = PromptTemplate.fromTemplate(promptTemplate);

      const combineDocsChain = await createStuffDocumentsChain({
        llm: this.llm,
        prompt,
      });

      const retrievalChain = await createRetrievalChain({
        retriever,
        combineDocsChain,
      });

      const response = await retrievalChain.invoke({
        input: query,
      });

      return response.answer;
    } catch (error) {
      console.error("Error in AI Chatbot logic:", error);
      throw new Error("Failed to process chat query.");
    }
  }
}

module.exports = new RagService();

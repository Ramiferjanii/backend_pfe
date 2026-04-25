require('dotenv').config();

const { CallbackHandler } = require("langfuse-langchain");
const { ChatGroq } = require("@langchain/groq");

async function run() {
    console.log("--- Langfuse Trace Test ---");
    console.log("LANGFUSE_PUBLIC_KEY:", process.env.LANGFUSE_PUBLIC_KEY?.slice(0, 20) + "...");
    console.log("LANGFUSE_SECRET_KEY:", process.env.LANGFUSE_SECRET_KEY?.slice(0, 20) + "...");
    console.log("LANGFUSE_BASE_URL:", process.env.LANGFUSE_BASE_URL);

    const langfuseHandler = new CallbackHandler({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        baseUrl: process.env.LANGFUSE_BASE_URL,
        tags: ["test-trace"]
    });

    const llm = new ChatGroq({
        apiKey: process.env.GROQ_API_KEY,
        model: "llama-3.1-8b-instant",
        temperature: 0.2
    });

    console.log("\nSending test message to Groq via LangChain...");

    const response = await llm.invoke(
        [["user", "Say hello in one word."]],
        { callbacks: [langfuseHandler] }
    );

    console.log("LLM response:", response.content);
    console.log("Trace ID:", langfuseHandler.traceId || langfuseHandler.last_trace_id || "check manually");

    console.log("\nFlushing events to Langfuse...");
    await langfuseHandler.flushAsync();
    console.log("Done! Check your Langfuse dashboard now.");
}

run().catch(err => {
    console.error("ERROR:", err.message || err);
    process.exit(1);
});

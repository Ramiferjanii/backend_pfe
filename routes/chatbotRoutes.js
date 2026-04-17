const express = require('express');
const router = express.Router();
const ragService = require('../services/ragService');

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.post('/query', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }

    const answer = await ragService.handleChatQuery(message);

    // Track the question
    const question = message.trim().slice(0, 300);
    try {
      await prisma.chatQuestion.upsert({
        where: { question },
        update: { count: { increment: 1 } },
        create: { question },
      });
    } catch (dbErr) {
      console.error('Failed to save chatbot question:', dbErr.message);
    }

    res.json({ answer });
  } catch (error) {
    console.error("Chatbot Error:", error);
    res.status(500).json({ error: "An error occurred while communicating with the AI chatbot." });
  }
});

router.post('/init', async (req, res) => {
  try {
    await ragService.initializeVectorDB();
    res.json({ message: "Vector DB successfully initialized and populated." });
  } catch (error) {
    res.status(500).json({ error: "Failed to initialize Vector DB." });
  }
});

module.exports = router;

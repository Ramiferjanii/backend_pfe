const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { chatWithAssistant } = require('../services/aiService');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// POST: Process a message from the Floating Chatbot
router.post('/', auth, async (req, res) => {
    try {
        const { messages } = req.body;
        
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Messages array is required' });
        }

        // Send conversation to Groq along with the user ID for context finding
        const reply = await chatWithAssistant(messages, req.user.id);

        // Save the last user question to the DB (upsert by question text)
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        if (lastUserMsg && lastUserMsg.content) {
            // Normalize: trim and limit to 300 chars
            const question = lastUserMsg.content.trim().slice(0, 300);
            try {
                await prisma.chatQuestion.upsert({
                    where: { question },
                    update: { count: { increment: 1 } },
                    create: { question },
                });
            } catch (dbErr) {
                console.error('Failed to save chat question:', dbErr.message);
            }
        }

        res.json({ success: true, reply });
    } catch (error) {
        console.error('Chat endpoint error:', error);
        res.status(500).json({ error: 'Failed to process chat message', details: error.message });
    }
});

// GET: Return the top most-asked questions (for Help Center FAQ)
router.get('/top-questions', async (req, res) => {
    try {
        const questions = await prisma.chatQuestion.findMany({
            orderBy: { count: 'desc' },
            take: 10,
            select: { question: true, count: true },
        });
        res.json({ questions });
    } catch (error) {
        console.error('Top questions error:', error);
        res.status(500).json({ error: 'Failed to fetch top questions' });
    }
});

module.exports = router;

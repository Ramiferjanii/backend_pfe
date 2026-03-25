const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { chatWithAssistant } = require('../services/aiService');

// POST: Process a message from the Floating Chatbot
router.post('/', auth, async (req, res) => {
    try {
        const { messages } = req.body;
        
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Messages array is required' });
        }

        // Send conversation to Groq along with the user ID for context finding
        const reply = await chatWithAssistant(messages, req.user.id);

        res.json({ success: true, reply });
    } catch (error) {
        console.error('Chat endpoint error:', error);
        res.status(500).json({ error: 'Failed to process chat message', details: error.message });
    }
});

module.exports = router;

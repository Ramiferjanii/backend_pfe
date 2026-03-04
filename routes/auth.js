const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabaseService');
const prisma = require('../lib/prisma');

// Sync User from Supabase Auth to Public User Table
router.post('/sync-user', async (req, res) => {
    const { id, email, name, full_name, image } = req.body;

    if (!id || !email) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        // Check if user exists by email first (to handle email conflicts)
        let existingUser = await prisma.user.findUnique({ where: { email } });

        if (!existingUser) {
            // Then check by ID
            existingUser = await prisma.user.findUnique({ where: { id } });
        }

        let user;
        if (existingUser) {
            // Update existing user
            user = await prisma.user.update({
                where: { id: existingUser.id },
                data: {
                    email: email,
                    name: name || full_name || email.split('@')[0],
                    image: image || undefined, // Only update if provided
                },
            });
        } else {
            // Create new user
            user = await prisma.user.create({
                data: {
                    id: id,
                    email: email,
                    name: name || full_name || email.split('@')[0],
                    image: image,
                },
            });
        }
        console.log(`[AUTH] Synced user: ${user.id}`);
        res.json({ success: true, user });
    } catch (error) {
        console.error("[AUTH] Error syncing user:", error);
        res.status(500).json({ error: "Failed to sync user" });
    }
});

// Debug Middleware to trace Auth Requests
router.use((req, res, next) => {
    console.log(`[AUTH ROUTE] ${req.method} ${req.originalUrl}`);
    next();
});

// Endpoint for frontend to fetch UserID by email (needed for existing user OTP flow)
router.post('/get-user-id', async (req, res) => {
    console.log(`[AUTH] Lookup request for: ${req.body.email}`);
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    try {
        const { data: { users }, error } = await supabase.auth.admin.listUsers();
        if (error) throw error;

        const user = users.find(u => u.email === email);

        if (user) {
            console.log(`[AUTH] User found: ${user.id}`);
            return res.json({ userId: user.id, exists: true });
        } else {
            console.log(`[AUTH] User not found for email: ${email}`);
            return res.status(404).json({ error: "User not found", exists: false });
        }
    } catch (err) {
        console.error("[AUTH] Error looking up user:", err);
        return res.status(500).json({ error: err.message });
    }
});

// Test Endpoint verify route loading
router.get('/test', (req, res) => {
    res.json({ message: "Auth Routes working on 5002", timestamp: new Date().toISOString() });
});

module.exports = router;

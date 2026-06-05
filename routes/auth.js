const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabaseService');
const prisma = require('../lib/prisma');

// Sync User from Supabase Auth to Public User Table
router.post('/sync-user', async (req, res) => {
    const { id, email, name, full_name, image, location } = req.body;

    if (!id || !email) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        const dataToSave = {
            name: name || full_name || email.split('@')[0],
        };
        if (location !== undefined) dataToSave.location = location;
        if (image !== undefined) dataToSave.image = image || null;

        // First, check if there's an old record with same email but different ID
        // (happens when user is deleted from Supabase and re-registers)
        const existingByEmail = await prisma.user.findUnique({ where: { email } });
        if (existingByEmail && existingByEmail.id !== id) {
            console.log(`[AUTH] User re-created in Supabase. Old ID: ${existingByEmail.id}, New ID: ${id}. Migrating...`);
            await prisma.user.delete({ where: { id: existingByEmail.id } });
        }

        // Atomic upsert — no race condition possible
        const user = await prisma.user.upsert({
            where: { id },
            update: {
                email,
                ...dataToSave,
            },
            create: {
                id,
                email,
                ...dataToSave,
            },
        });

        console.log(`[AUTH] Synced user: ${user.id}`);
        res.json({ success: true, user });
    } catch (error) {
        console.error("[AUTH] Error syncing user:", error.message);
        res.status(500).json({ error: "Failed to sync user", details: error.message });
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

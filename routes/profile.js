const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabaseService');
const auth = require('../middleware/auth');

// GET Profile
router.get('/', auth, async (req, res) => {
    try {
        // req.user is already populated by the auth middleware
        res.json(req.user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server Error' });
    }
});

// UPDATE Profile
router.put('/', auth, async (req, res) => {
    const { name, email, password, image } = req.body;

    try {
        const attributes = {};
        if (email) attributes.email = email;
        if (password) attributes.password = password;
        
        // Met à jour les métadonnées (nom et image/photo)
        if (name || image) {
            attributes.user_metadata = { ...req.user.user_metadata };
            if (name) attributes.user_metadata.name = name;
            if (name) attributes.user_metadata.full_name = name; // Garde la cohérence avec le frontend
            if (image) attributes.user_metadata.avatar_url = image; // Stocke l'URL de l'image
        }

        if (Object.keys(attributes).length === 0) {
             return res.status(400).json({ error: 'No fields to update' });
        }

        const { data: { user }, error } = await supabase.auth.admin.updateUserById(
            req.user.id,
            attributes
        );

        if (error) throw error;

        res.json({
            message: 'Profile updated successfully',
            user: {
                id: user.id,
                email: user.email,
                name: user.user_metadata?.name,
                ...user.user_metadata
            }
        });
    } catch (err) {
        console.error("Profile Update Error:", err);
        res.status(500).json({ error: err.message || 'Server Error' });
    }
});

module.exports = router;


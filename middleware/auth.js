const { supabase } = require('../services/supabaseService');

module.exports = async function(req, res, next) {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        try {
            const { data: { user }, error } = await supabase.auth.getUser(token);

            if (error || !user) {
                return res.status(401).json({ error: error?.message || 'Invalid token' });
            }
            
            req.user = { 
                id: user.id, 
                email: user.email, 
                ...user.user_metadata 
            };
            
            return next();
        } catch (ex) {
            attempts++;
            console.error(`Auth Attempt ${attempts} failed:`, ex.message);
            if (attempts >= maxAttempts) {
                res.status(401).json({ error: 'Authentication service unavailable. Please check your connection.' });
                return;
            }
            // Wait 1 second before retrying
            await new Promise(r => setTimeout(r, 1000));
        }
    }
};


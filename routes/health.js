const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { exec } = require('child_process');
const path = require('path');

router.get('/diagnostics', async (req, res) => {
    const diagnostics = {
        timestamp: new Date().toISOString(),
        database: 'unknown',
        python: 'unknown',
        environment: process.env.NODE_ENV || 'development',
        env_vars: {
            RAINFOREST_API_KEY: !!process.env.RAINFOREST_API_KEY,
            DATABASE_URL_SET: !!process.env.DATABASE_URL,
            SUPABASE_URL_SET: !!process.env.SUPABASE_URL
        }
    };

    // 1. Check Database
    try {
        await prisma.$queryRaw`SELECT 1`;
        diagnostics.database = 'connected';
    } catch (err) {
        diagnostics.database = `error: ${err.message}`;
    }

    // 2. Check Python
    try {
        const pythonCheck = new Promise((resolve) => {
            // Try python3 then python
            exec('python3 --version', (err3, stdout3) => {
                if (!err3) return resolve({ version: stdout3.trim(), cmd: 'python3' });
                exec('python --version', (err, stdout) => {
                    if (!err) return resolve({ version: stdout.trim(), cmd: 'python' });
                    resolve({ version: 'not found', error: err3.message });
                });
            });
        });
        diagnostics.python = await pythonCheck;
    } catch (err) {
        diagnostics.python = `error: ${err.message}`;
    }

    // 3. Check for specific libraries
    if (diagnostics.python.cmd) {
        const libCheck = new Promise((resolve) => {
            const cmd = `${diagnostics.python.cmd} -c "import requests; import vaderSentiment; print('libs_ok')"`;
            exec(cmd, (err, stdout) => {
                if (!err && stdout.trim() === 'libs_ok') {
                    resolve('installed');
                } else {
                    resolve(`missing or error: ${err?.message || 'unknown'}`);
                }
            });
        });
        diagnostics.libraries = await libCheck;
    }

    res.json(diagnostics);
});

module.exports = router;

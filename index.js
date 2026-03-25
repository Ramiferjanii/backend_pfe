process.on('uncaughtException', (err) => { console.error('UNCAUGHT EXCEPTION:', err); });
process.on('unhandledRejection', (reason, promise) => { console.error('UNHANDLED REJECTION:', reason); });

require('dotenv').config();
const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const cors = require('cors');
const authRoutes = require('./routes/auth.js');
const websiteRoutes = require('./routes/websites.js');
const productRoutes = require('./routes/products.js');
const reviewRoutes = require('./routes/reviews.js');
const dashboardRoutes = require('./routes/dashboard.js');
const port = 5003;

// Middleware
app.use(cors()); // Enable CORS for all origins
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// CORS headers (extra layer)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/profile', require('./routes/profile'));
app.use('/api/websites', websiteRoutes);
app.use('/api/products', productRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/chat', require('./routes/chat'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', require('./routes/reports'));

// API Info endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'Express REST API - BrandSight',
        version: '1.0.0',
        endpoints: {
            auth: {
                register: 'POST /api/auth/register',
                login: 'POST /api/auth/login'
            },
            websites: {
                create: 'POST /api/websites',
                getAll: 'GET /api/websites',
                getById: 'GET /api/websites/:id',
                update: 'PUT /api/websites/:id',
                updateScrapeData: 'PATCH /api/websites/:id/scrape',
                triggerScrape: 'POST /api/websites/:id/scrape-trigger',
                delete: 'DELETE /api/websites/:id',
                bulkDelete: 'POST /api/websites/bulk-delete'
            },
            products: {
                getAll: 'GET /api/products',
                getById: 'GET /api/products/:id',
                query: 'GET /api/products?q=...&category=...&domain=...',
                share: 'POST /api/products/:id/share { "type": "whatsapp", "destination": "+216..." }'
            },
            reviews: {
                fetchOne: 'POST /api/reviews/fetch/:productId',
                fetchBatch: 'POST /api/reviews/fetch-batch',
                list: 'GET  /api/reviews/:productId',
                summary: 'GET  /api/reviews/:productId/summary',
                delete: 'DELETE /api/reviews/:productId'
            }
        }
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('SERVER ERROR:', err.stack);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// Start server
app.listen(port, () => {
    console.log(`REST API Server running on http://localhost:${port}`);
    console.log(`API Documentation: http://localhost:${port}/`);
});

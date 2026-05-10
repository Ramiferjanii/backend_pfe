# BrandSight API - Market Intelligence Backend

This is the core REST API for the BrandSight platform, handling authentication, scraping coordination, AI analysis, and data persistence.

## Features

- ✅ **JWT Authentication**: Secure user sessions via Supabase/JWT.
- ✅ **Scraping Engine**: Coordination of Python-based scrapers (Selenium/Requests).
- ✅ **AI Integration**: Market insights and product categorization via Llama-3 (Groq).
- ✅ **RAG Service**: Retrieval-Augmented Generation for intelligent market queries.
- ✅ **Prisma ORM**: Robust database interactions with PostgreSQL.
- ✅ **Email Service**: Automated notifications for scraping completion.

## Tech Stack

- **Node.js** - Runtime environment
- **Express.js** - Web framework
- **Prisma** - ORM
- **PostgreSQL** - Database
- **Groq SDK** - Llama-3 AI models
- **Nodemailer** - Email delivery

## Installation

1.  **Clone and Install**:
    ```bash
    npm install
    ```

2.  **Environment Variables**:
    Create a `.env` file based on `.env.example`:
    ```env
    DATABASE_URL="your-postgresql-url"
    SUPABASE_URL="your-supabase-url"
    SUPABASE_ANON_KEY="your-anon-key"
    GROQ_API_KEY="your-groq-key"
    SMTP_HOST="your-smtp-host"
    SMTP_USER="your-smtp-user"
    SMTP_PASS="your-smtp-pass"
    ```

3.  **Database Migration**:
    ```bash
    npx prisma generate
    npx prisma db push
    ```

## Running the Server

```bash
npm start
```
The API will be available at: `http://localhost:5003`

## License
ISC

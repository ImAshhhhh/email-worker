import { PostalMime } from 'postal-mime';

// ----- OTP extractor -----
function extractOTP(text) {
    if (!text) return null;
    const patterns = [
        /\b(\d{4,8})\b/,
        /verification code[:\s]*(\d{4,8})/i,
        /OTP[:\s]*(\d{4,8})/i,
        /code[:\s]*(\d{4,8})/i,
        /验证码[:\s]*(\d{4,8})/i
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            const code = match[1];
            if (!/^(19|20)\d{2}$/.test(code) && !/^\d{1,2}:\d{2}$/.test(code)) {
                return code;
            }
        }
    }
    return null;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        // ----- /setup – one‑time schema creation -----
        if (path === '/setup') {
            try {
                await env.DB.exec(
                    `CREATE TABLE IF NOT EXISTS emails (
                        id TEXT PRIMARY KEY,
                        recipient TEXT NOT NULL,
                        sender TEXT,
                        subject TEXT,
                        text_body TEXT,
                        html_body TEXT,
                        received_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    );
                    CREATE INDEX IF NOT EXISTS idx_recipient ON emails(recipient);`
                );
                return new Response(JSON.stringify({ success: true, message: 'Schema created' }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (err) {
                return new Response(JSON.stringify({ success: false, error: err.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        // ----- /all – returns all emails (latest 200) with OTP -----
        if (path === '/all') {
            const { results } = await env.DB.prepare(
                `SELECT * FROM emails ORDER BY received_at DESC LIMIT 200`
            ).all();
            const withOtp = results.map(row => ({
                ...row,
                otp: extractOTP(row.html_body || row.text_body)
            }));
            return new Response(JSON.stringify({
                success: true,
                count: withOtp.length,
                emails: withOtp
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // ----- /inbox/<email> – filter by recipient -----
        const match = path.match(/^\/inbox\/(.+)$/);
        if (match) {
            const emailAddress = match[1];
            const { results } = await env.DB.prepare(
                `SELECT * FROM emails WHERE recipient = ? ORDER BY received_at DESC`
            ).bind(emailAddress).all();
            const withOtp = results.map(row => ({
                ...row,
                otp: extractOTP(row.html_body || row.text_body)
            }));
            return new Response(JSON.stringify({
                success: true,
                email: emailAddress,
                count: withOtp.length,
                emails: withOtp
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        return new Response('Not found', { status: 404 });
    },

    // ----- Email handler (called by Cloudflare Email Routing) -----
    async email(message, env, ctx) {
        const parser = new PostalMime();
        const email = await parser.parse(message.raw);

        const to = message.to;
        const id = crypto.randomUUID();

        await env.DB.prepare(
            `INSERT INTO emails (id, recipient, sender, subject, text_body, html_body, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            id,
            to,
            message.from,
            email.subject || '',
            email.text || '',
            email.html || '',
            new Date().toISOString()
        ).run();
    }
};

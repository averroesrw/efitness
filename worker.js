const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
}

const PRODUCT_TYPES = {
    '10645583462666': 'hubnuti',
    '10645580480778': 'nabrani',
    '10645583397130': 'bundle',
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
const RESEND_API_URL = 'https://api.resend.com/emails'
const FROM_EMAIL = 'info@e-fitness.eu'

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json; charset=UTF-8',
        },
    })
}

function generateCode() {
    const randomValues = new Uint32Array(CODE_LENGTH)
    crypto.getRandomValues(randomValues)

    return Array.from(randomValues, (value) => (
        CODE_ALPHABET[value % CODE_ALPHABET.length]
    )).join('')
}

function getProductId(payload) {
    const lineItems = payload.line_items ?? payload.lineItems ?? []
    const firstItem = lineItems[0]
    const productId = firstItem?.product_id ?? firstItem?.variant_id

    return productId === undefined || productId === null
        ? null
        : String(productId)
}

function getCustomerEmail(payload) {
    const email = payload.email
        ?? payload.contact_email
        ?? payload.customer?.email

    return typeof email === 'string' && email.trim().length > 0
        ? email.trim().toLowerCase()
        : null
}

async function createUniqueCode(env, productType, email) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = generateCode()
        const result = await env.DB.prepare(
            'INSERT OR IGNORE INTO codes (code, product_type, customer_email, used) VALUES (?, ?, ?, 0)',
        )
            .bind(code, productType, email)
            .run()

        if (result.meta.changes === 1) {
            return code
        }
    }

    throw new Error('Nepodařilo se vygenerovat unikátní kód.')
}

async function sendCodeEmail(apiKey, email, code, productType) {
    const resendResponse = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: FROM_EMAIL,
            to: [email],
            subject: 'Tvůj přístupový kód k eFitness tréninku',
            text: [
                'Děkujeme za nákup digitálního produktu eFitness.',
                '',
                `Tvůj přístupový kód: ${code}`,
                `Typ produktu: ${productType}`,
                '',
                'Kód zadej na stránce svého eFitness tréninku.',
            ].join('\n'),
        }),
    })

    if (!resendResponse.ok) {
        const errorText = await resendResponse.text()
        console.error('Resend API error:', errorText)
        throw new Error('E-mail s kódem se nepodařilo odeslat.')
    }
}

async function handleWebhook(request, env) {
    let payload
    try {
        payload = await request.json()
    } catch {
        return jsonResponse({ success: false, message: 'Tělo požadavku není platný JSON.' }, 400)
    }

    const email = getCustomerEmail(payload)
    const productId = getProductId(payload)
    const productType = productId ? PRODUCT_TYPES[productId] : undefined

    if (!email || !productType) {
        return jsonResponse({
            success: false,
            message: 'Webhook neobsahuje platný e-mail zákazníka nebo podporovaný produkt.',
        }, 400)
    }

    if (!env.RESEND_API_KEY) {
        return jsonResponse({
            success: false,
            message: 'Na Workeru chybí RESEND_API_KEY.',
        }, 500)
    }

    try {
        const code = await createUniqueCode(env, productType, email)
        await sendCodeEmail(env.RESEND_API_KEY, email, code, productType)

        return jsonResponse({
            success: true,
            message: 'Kód byl vytvořen a odeslán zákazníkovi.',
        })
    } catch (error) {
        console.error('Webhook processing error:', error)
        return jsonResponse({
            success: false,
            message: 'Při zpracování objednávky nastala chyba.',
        }, 500)
    }
}

async function handleVerify(request, env) {
    let body
    try {
        body = await request.json()
    } catch {
        return jsonResponse({ success: false, message: 'Tělo požadavku není platný JSON.' }, 400)
    }

    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : ''
    if (!/^[A-Z0-9]{8}$/.test(code)) {
        return jsonResponse({ success: false, message: 'Kód musí mít 8 alfanumerických znaků.' }, 400)
    }

    try {
        const updateResult = await env.DB.prepare(
            'UPDATE codes SET used = 1 WHERE code = ? AND used = 0 RETURNING product_type',
        )
            .bind(code)
            .first()

        if (!updateResult) {
            const record = await env.DB.prepare(
                'SELECT code, used FROM codes WHERE code = ? LIMIT 1',
            )
                .bind(code)
                .first()

            return jsonResponse({
                success: false,
                message: record ? 'Tento kód už byl použit.' : 'Neplatný nebo neexistující kód.',
            }, 400)
        }

        return jsonResponse({
            success: true,
            productType: updateResult.product_type,
        })
    } catch (error) {
        console.error('Verify error:', error)
        return jsonResponse({
            success: false,
            message: 'Při ověřování kódu nastala chyba.',
        }, 500)
    }
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 200, headers: CORS_HEADERS })
        }

        if (request.method !== 'POST') {
            return jsonResponse({ success: false, message: 'Metoda není podporována.' }, 405)
        }

        const url = new URL(request.url)

        try {
            if (url.pathname === '/webhook') {
                return await handleWebhook(request, env)
            }

            if (url.pathname === '/verify') {
                return await handleVerify(request, env)
            }

            return jsonResponse({ success: false, message: 'Endpoint nebyl nalezen.' }, 404)
        } catch (error) {
            console.error('Unhandled Worker error:', error)
            return jsonResponse({ success: false, message: 'Interní chyba serveru.' }, 500)
        }
    },
}
